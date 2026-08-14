/**
 * Tests for the policy/metadata validation harness (issue #7).
 *
 * These exercise the `runPolicy` harness from `scripts/policy.mjs`, which
 * deterministically validates the committed waivers file, the production
 * reference-pack manifests, and the guidance metadata. The success case runs
 * against this repository's committed policy and cache; the failure cases
 * exercise the diagnostic paths that make the policy check fail with a
 * non-zero status.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runPolicy } from "../scripts/policy.mjs"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const POLICY = fileURLToPath(new URL("../scripts/policy.mjs", import.meta.url))
const runProcess = (args: Array<string>) =>
  spawnSync(process.execPath, ["--experimental-strip-types", POLICY, ...args], {
    encoding: "utf8",
    cwd: repoRoot
  })

const tempDir = (): string => mkdtempSync(join(tmpdir(), "effect-lens-policy-"))

const write = (dir: string, rel: string, content: string): void => {
  const path = join(dir, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content, "utf8")
}

const VALID_MANIFEST = JSON.stringify({
  id: "pack-test",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: {
    name: "effect",
    version: "4.0.0-rc.109",
    source: "lockfile",
    integrity: null
  },
  upstream: {
    repository: "effect-ts/effect",
    ref: "v4.0.0-rc.109",
    commit: "deadbeef",
    sourceUrl: null
  },
  includedPaths: ["LLMS.md"],
  sourceUrl: null,
  integrity: null,
  attribution: null,
  status: "complete"
})

describe("policy", () => {
  it("passes against this repository's committed policy and cache", () => {
    const result = runPolicy({ repoRoot })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => c.name)).toEqual(["waivers", "packs", "guidance"])
    for (const c of result.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
    }
    expect(result.payloads.waivers.count).toBe(0)
    expect(result.payloads.packs.packs.length).toBeGreaterThan(0)
    expect(result.payloads.guidance.problems).toEqual([])
    // Deferred checks are reported explicitly, not silently skipped.
    expect(result.unsupported.length).toBeGreaterThan(0)
  })

  it("fails the waivers check on a scope/path inconsistency", () => {
    const dir = tempDir()
    write(
      dir,
      "waivers.json",
      JSON.stringify([
        {
          id: "w-bad",
          rule: "lens/no-async-function",
          scope: "global",
          path: "src/bridge.ts",
          reason: "test",
          createdBy: "test",
          expiresAt: null
        }
      ])
    )
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir })
    expect(result.ok).toBe(false)
    const waivers = result.checks.find((c) => c.name === "waivers")
    expect(waivers?.ok).toBe(false)
    expect(waivers?.detail).toContain("waiver problem")
    expect(result.payloads.waivers.problems[0]).toContain("global scope but a path")
  })

  it("fails the waivers check on a schema-invalid waiver", () => {
    const dir = tempDir()
    write(
      dir,
      "waivers.json",
      JSON.stringify([
        {
          id: "w-bad",
          rule: "",
          scope: "file",
          path: "src/bridge.ts",
          reason: "test",
          createdBy: "test",
          expiresAt: null
        }
      ])
    )
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir })
    expect(result.ok).toBe(false)
    const waivers = result.checks.find((c) => c.name === "waivers")
    expect(waivers?.ok).toBe(false)
    expect(result.payloads.waivers.problems[0]).toContain("does not decode")
  })

  it("fails the packs check when an included file is missing", () => {
    const dir = tempDir()
    const packDir = join(dir, "pack-test")
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, "manifest.json"), VALID_MANIFEST, "utf8")
    writeFileSync(join(packDir, "LLMS.md"), "# Effect guidance\n", "utf8")
    // Declare a second included file that does not exist on disk.
    const manifest = JSON.parse(VALID_MANIFEST)
    manifest.includedPaths = ["LLMS.md", "missing.md"]
    writeFileSync(join(packDir, "manifest.json"), JSON.stringify(manifest), "utf8")
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir: dir })
    expect(result.ok).toBe(false)
    const packs = result.checks.find((c) => c.name === "packs")
    expect(packs?.ok).toBe(false)
    expect(result.payloads.packs.problems[0]).toContain("missing included file")
  })

  it("reports a future-dated waiver as valid and not expired", () => {
    const dir = tempDir()
    write(
      dir,
      "waivers.json",
      JSON.stringify([
        {
          id: "w-future",
          rule: "lens/no-async-function",
          scope: "file",
          path: "src/bridge.ts",
          reason: "test",
          createdBy: "test",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ])
    )
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir })
    expect(result.ok).toBe(true)
    expect(result.payloads.waivers.count).toBe(1)
    expect(result.payloads.waivers.expired).toEqual([])
  })

  it("reports an expired waiver without failing the check", () => {
    const dir = tempDir()
    write(
      dir,
      "waivers.json",
      JSON.stringify([
        {
          id: "w-expired",
          rule: "lens/no-async-function",
          scope: "file",
          path: "src/bridge.ts",
          reason: "test",
          createdBy: "test",
          expiresAt: "2020-01-01T00:00:00.000Z"
        }
      ])
    )
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir })
    expect(result.ok).toBe(true)
    expect(result.payloads.waivers.expired).toEqual(["w-expired"])
  })

  it("fails the packs check when a production pack is not complete", () => {
    const dir = tempDir()
    const packDir = join(dir, "pack-test")
    mkdirSync(packDir, { recursive: true })
    const manifest = JSON.parse(VALID_MANIFEST)
    manifest.status = "stale"
    writeFileSync(join(packDir, "manifest.json"), JSON.stringify(manifest), "utf8")
    writeFileSync(join(packDir, "LLMS.md"), "# Effect guidance\n", "utf8")
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir: dir })
    expect(result.ok).toBe(false)
    const packs = result.checks.find((c) => c.name === "packs")
    expect(packs?.ok).toBe(false)
    expect(result.payloads.packs.problems[0]).toContain("expected complete")
  })

  it("fails the guidance check on a malformed guidance block", () => {
    const dir = tempDir()
    const packDir = join(dir, "pack-test")
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, "manifest.json"), VALID_MANIFEST, "utf8")
    // A level-2 heading with no summary paragraph produces a warning.
    writeFileSync(join(packDir, "LLMS.md"), "# Effect guidance\n\n## Piping\n", "utf8")
    const result = runPolicy({ repoRoot, waiversFile: join(dir, "waivers.json"), cacheDir: dir })
    expect(result.ok).toBe(false)
    const guidance = result.checks.find((c) => c.name === "guidance")
    expect(guidance?.ok).toBe(false)
    expect(result.payloads.guidance.problems[0]).toContain("no summary")
  })
})

describe("policy process", () => {
  it("exits 0 and prints the passed summary against the repository", () => {
    const result = runProcess([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("policy passed")
    expect(result.stdout).toContain("ok: waivers")
    expect(result.stdout).toContain("ok: packs")
    expect(result.stdout).toContain("ok: guidance")
    expect(result.stdout).toContain("deferred (not enforced)")
  })

  it("exits 1 and names the failing check for a broken waivers file", () => {
    const dir = tempDir()
    write(
      dir,
      "waivers.json",
      JSON.stringify([
        {
          id: "w-bad",
          rule: "lens/no-async-function",
          scope: "global",
          path: "src/bridge.ts",
          reason: "test",
          createdBy: "test",
          expiresAt: null
        }
      ])
    )
    const result = runProcess(["--waivers", join(dir, "waivers.json")])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("policy FAILED")
    expect(result.stdout).toContain("FAILED: waivers")
  })
})
