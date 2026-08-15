/**
 * Tests for the self-dogfood check (issue #7).
 *
 * These exercise the `runDogfood` harness from `scripts/dogfood.mjs`, which
 * spawns the real CLI against a project and asserts the expected doctor,
 * drift, check, setup, and hooks outcomes. The success case runs against this repository's
 * production source; the failure cases exercise the diagnostic paths that make
 * the self-check fail with a non-zero status.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runDogfood } from "../scripts/dogfood.mjs"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const project = (name: string) =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))
const DOGFOOD = fileURLToPath(new URL("../scripts/dogfood.mjs", import.meta.url))
const runProcess = (args: Array<string>) =>
  spawnSync(process.execPath, [DOGFOOD, ...args], { encoding: "utf8", cwd: repoRoot })

interface DogfoodPayloads {
  doctor?: {
    resolution?: { status?: string }
    pack?: { status?: string }
    machineOutput?: { status?: number }
  }
  check?: { oxlint?: { files?: number }; machineOutput?: { findings?: Array<unknown> } }
  setup?: { plan?: { oxlint?: { status?: string } } }
  hooks?: { hooks?: { managers?: Array<unknown> } }
}

const payloadsOf = (result: { payloads: unknown }): DogfoodPayloads =>
  result.payloads as DogfoodPayloads

describe("self-dogfood", () => {
  it("passes against this repository's production source", () => {
    const result = runDogfood({ projectDir: repoRoot, cacheDir })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => c.name)).toEqual([
      "doctor",
      "drift",
      "check",
      "setup",
      "hooks"
    ])
    for (const c of result.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
    }
    const payloads = payloadsOf(result)
    expect(payloads.doctor?.resolution?.status).toBe("resolved")
    expect(payloads.doctor?.pack?.status).toBe("complete")
    expect(payloads.check?.oxlint?.files).toBeGreaterThan(0)
    expect(payloads.setup?.plan?.oxlint?.status).toBe("configured")
    expect(payloads.hooks?.hooks?.managers?.length).toBeGreaterThan(0)
  }, 30000)

  it("fails the doctor check when the project has no effect dependency", () => {
    const result = runDogfood({ projectDir: project("missing-dependency"), cacheDir })
    expect(result.ok).toBe(false)
    const doctor = result.checks.find((c) => c.name === "doctor")
    expect(doctor?.ok).toBe(false)
    expect(doctor?.detail).toContain("expected a declared effect dependency")
    // Assert the real outcome, not just the harness's summary string.
    const payloads = payloadsOf(result)
    expect(payloads.doctor?.machineOutput?.status).toBe(2)
    expect(payloads.doctor?.resolution?.status).toBe("missing")
  }, 30000)

  it("fails the check when the target path has Lens findings", () => {
    const result = runDogfood({
      projectDir: repoRoot,
      cacheDir,
      path: "test/fixtures/rules/no-async-function.fail.ts"
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c) => c.name === "check")
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain("expected 0 findings")
    // Assert the real outcome: the CLI actually linted files and found findings.
    const payloads = payloadsOf(result)
    expect(payloads.check?.oxlint?.files).toBeGreaterThan(0)
    expect(payloads.check?.machineOutput?.findings?.length).toBeGreaterThan(0)
  }, 30000)
})

describe("self-dogfood process", () => {
  it("exits 0 and prints the passed summary against the repository", () => {
    const result = runProcess([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("self-dogfood passed")
    expect(result.stdout).toContain("ok: doctor")
    expect(result.stdout).toContain("ok: drift")
    expect(result.stdout).toContain("ok: check")
    expect(result.stdout).toContain("ok: setup")
    expect(result.stdout).toContain("ok: hooks")
  }, 30000)

  it("exits 1 and names the failing check for a broken project", () => {
    const result = runProcess([
      "--project",
      project("missing-dependency"),
      "--cache",
      cacheDir
    ])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("self-dogfood FAILED")
    expect(result.stdout).toContain("FAILED: doctor")
  }, 30000)
})
