/**
 * Unit tests for the Effect Lens CLI command functions.
 *
 * These exercise the `doctor`, `drift`, and `check` adapters directly against
 * the shared-core fixtures, asserting the {@link MachineOutput} status (which
 * drives the exit code) and the JSON payload shape for both human and
 * machine-readable output.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { check } from "../src/cli/commands/check.ts"
import { doctor } from "../src/cli/commands/doctor.ts"
import { drift } from "../src/cli/commands/drift.ts"

const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))
const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const cacheStaleDir = fileURLToPath(new URL("./fixtures/cache-stale", import.meta.url))
const cachePartialDir = fileURLToPath(new URL("./fixtures/cache-partial", import.meta.url))
const cacheMonoDir = fileURLToPath(new URL("./fixtures/cache-mono", import.meta.url))
const monorepo = fileURLToPath(new URL("./fixtures/projects/monorepo", import.meta.url))
const unifiedProject = fileURLToPath(new URL("./fixtures/projects/check-unified", import.meta.url))

describe("doctor", () => {
  it("reports a resolved project with a complete pack as ok", () => {
    const result = doctor({ projectDir: project("npm-valid"), cacheDir })
    expect(result.machineOutput.status).toBe(0)
    expect(result.machineOutput.diagnostics).toHaveLength(0)
  })

  it("reports a missing effect dependency as an error", () => {
    const result = doctor({ projectDir: project("missing-dependency"), cacheDir })
    expect(result.machineOutput.status).toBe(2)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "doctor-effect-missing")).toBe(
      true
    )
  })

  it("reports an installed mismatch as a warning", () => {
    const result = doctor({ projectDir: project("installed-mismatch"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "doctor-installed-mismatch")
    ).toBe(true)
  })

  it("reports a stale reference pack as a warning", () => {
    const result = doctor({ projectDir: project("npm-valid"), cacheDir: cacheStaleDir })
    expect(result.machineOutput.status).toBe(1)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "doctor-pack-stale")).toBe(true)
  })

  it("reports a partial reference pack as a warning", () => {
    const result = doctor({ projectDir: project("npm-valid"), cacheDir: cachePartialDir })
    expect(result.machineOutput.status).toBe(1)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "doctor-pack-partial")).toBe(
      true
    )
  })

  it("emits a JSON payload with machineOutput, resolution, and pack", () => {
    const result = doctor({ projectDir: project("npm-valid"), cacheDir })
    const json = result.json as {
      machineOutput: { status: number }
      resolution: { status: string }
      pack: { status: string }
    }
    expect(json.machineOutput.status).toBe(0)
    expect(json.resolution.status).toBe("resolved")
    expect(json.pack.status).toBe("complete")
  })

  it("emits human-readable lines", () => {
    const result = doctor({ projectDir: project("npm-valid"), cacheDir })
    expect(result.human[0]).toBe("effect-lens doctor")
    expect(result.human.join("\n")).toContain("reference pack: pack-effect-109 [complete]")
  })

  it("resolves a workspace target from a root pnpm lockfile", () => {
    const result = doctor({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as {
      resolution: { status: string; expected: { version: string } | null; lockfile: string }
      pack: { status: string; pack: { id: string } | null }
    }
    expect(json.resolution.lockfile).toBe("pnpm-lock")
    expect(json.resolution.status).toBe("resolved")
    expect(json.resolution.expected?.version).toBe("4.0.0-beta.83")
    // Target-specific pack selection: the beta pack is chosen, not the 109 one.
    expect(json.pack.status).toBe("complete")
    expect(json.pack.pack?.id).toBe("pack-effect-beta83")
  })

  it("selects a different reference pack per workspace effect version", () => {
    const docs = doctor({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      workspace: "packages/docs"
    })
    const docsJson = docs.json as { pack: { pack: { id: string } | null } }
    expect(docsJson.pack.pack?.id).toBe("pack-effect-109")

    const foldkit = doctor({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    const foldkitJson = foldkit.json as { pack: { pack: { id: string } | null } }
    expect(foldkitJson.pack.pack?.id).toBe("pack-effect-beta83")
  })

  it("reports an unresolved workspace target as a blocking error", () => {
    const result = doctor({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      workspace: "does-not-exist"
    })
    expect(result.machineOutput.status).toBe(2)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "doctor-workspace-unresolved")
    ).toBe(true)
  })

  it("reports an ambiguous workspace target as a blocking error", () => {
    const result = doctor({ projectDir: monorepo, cacheDir: cacheMonoDir, workspace: "kit" })
    expect(result.machineOutput.status).toBe(2)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "doctor-workspace-ambiguous")
    ).toBe(true)
  })
})

describe("drift", () => {
  it("reports a compatible project as ok", () => {
    const result = drift({ projectDir: project("npm-valid"), cacheDir })
    expect(result.machineOutput.status).toBe(0)
  })

  it("reports an installed mismatch as a conflict warning", () => {
    const result = drift({ projectDir: project("installed-mismatch"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "drift-conflict-effect-dependency")
    ).toBe(
      true
    )
  })

  it("reports a missing dependency as a missing warning", () => {
    const result = drift({ projectDir: project("missing-dependency"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "drift-missing-effect-dependency"))
      .toBe(
        true
      )
  })

  it("reports a stale reference pack as a stale pack warning", () => {
    const result = drift({ projectDir: project("npm-valid"), cacheDir: cacheStaleDir })
    expect(result.machineOutput.status).toBe(1)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "drift-stale-effect-pack")).toBe(
      true
    )
  })

  it("reports a partial reference pack as a stale pack warning", () => {
    const result = drift({ projectDir: project("npm-valid"), cacheDir: cachePartialDir })
    expect(result.machineOutput.status).toBe(1)
    expect(result.machineOutput.diagnostics.some((d) => d.id === "drift-stale-effect-pack")).toBe(
      true
    )
  })

  it("emits unique diagnostic ids when dependency and pack both drift", () => {
    const result = drift({ projectDir: project("missing-lockfile"), cacheDir: cacheStaleDir })
    const ids = result.machineOutput.diagnostics.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("emits a JSON payload with a drift report", () => {
    const result = drift({ projectDir: project("npm-valid"), cacheDir })
    const json = result.json as {
      report: {
        toolchain: { lensVersion: string }
        entries: Array<{ kind: string }>
      }
    }
    expect(json.report.toolchain.lensVersion).toBe("0.0.0")
    expect(json.report.entries.length).toBeGreaterThan(0)
    expect(json.report.entries.every((e) => e.kind === "compatible")).toBe(true)
  })

  it("emits human-readable lines with the offline limitation note", () => {
    const result = drift({ projectDir: project("npm-valid"), cacheDir })
    expect(result.human[0]).toBe("effect-lens drift")
    expect(result.human.join("\n")).toContain("full upstream comparison is not available")
  })

  it("resolves a workspace target and reports the target's effect version", () => {
    const result = drift({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    const json = result.json as {
      report: { toolchain: { effect: { version: string } } }
    }
    expect(json.report.toolchain.effect.version).toBe("4.0.0-beta.83")
  })
})

describe("check", () => {
  it("aggregates findings from a failing fixture as an error", () => {
    const result = check({
      projectDir: project("npm-valid"),
      cacheDir,
      path: "../../rules/no-async-function.fail.ts"
    })
    expect(result.machineOutput.status).toBe(2)
    expect(result.machineOutput.findings.length).toBeGreaterThan(0)
    expect(result.machineOutput.findings[0].rule).toBe("lens/no-async-function")
  })

  it("reports a clean fixture as ok", () => {
    const result = check({
      projectDir: project("npm-valid"),
      cacheDir,
      path: "../../rules/no-async-function.pass.ts"
    })
    expect(result.machineOutput.status).toBe(0)
    expect(result.machineOutput.findings).toHaveLength(0)
  })

  it("emits a JSON payload with the review result", () => {
    const result = check({
      projectDir: project("npm-valid"),
      cacheDir,
      path: "../../rules/no-async-function.fail.ts"
    })
    const json = result.json as {
      review: { summary: { total: number; errors: number } }
      machineOutput: { status: number }
    }
    expect(json.review.summary.total).toBeGreaterThan(0)
    expect(json.review.summary.errors).toBe(json.review.summary.total)
    expect(json.machineOutput.status).toBe(2)
  })

  it("treats a target with no lintable files as a clean run", () => {
    const result = check({
      projectDir: project("npm-valid"),
      cacheDir,
      path: "../../rules/does-not-exist.ts"
    })
    expect(result.machineOutput.status).toBe(0)
    expect(result.machineOutput.findings).toHaveLength(0)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "check-oxlint-unavailable")
    ).toBe(false)
  })

  it("unified mode preserves project ignore/override behavior while loading Lens rules", () => {
    const result = check({ projectDir: unifiedProject, cacheDir, mode: "unified" })
    // The Lens rule is loaded and fires on src/a.ts.
    expect(
      result.machineOutput.findings.some((f) => f.rule === "lens/no-async-function")
    ).toBe(true)
    // ignored/b.ts is not linted (the project ignore is preserved).
    expect(
      result.machineOutput.findings.some((f) => f.location.file.includes("ignored/b.ts"))
    ).toBe(false)
    // src/override.ts no-console is overridden off (no diagnostic for it).
    expect(
      result.machineOutput.diagnostics.some((d) =>
        Option.getOrNull(d.location)?.file.includes("override.ts")
      )
    ).toBe(false)
    const json = result.json as { oxlint: { config: string; mode: string } }
    expect(json.oxlint.config).toBe("project")
    expect(json.oxlint.mode).toBe("unified")
  })

  it("unified mode preserves the project override (no-console off for src/override.ts)", () => {
    const result = check({
      projectDir: unifiedProject,
      cacheDir,
      mode: "unified",
      path: "src/override.ts"
    })
    expect(result.machineOutput.findings).toHaveLength(0)
    expect(result.machineOutput.diagnostics).toHaveLength(0)
  })

  it("emits a warning for an unparseable project config in unified mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-badcfg-"))
    writeFileSync(join(dir, ".oxlintrc.json"), "not json")
    try {
      const result = check({ projectDir: dir, cacheDir, mode: "unified" })
      expect(
        result.machineOutput.diagnostics.some((d) => d.id === "check-config-unparseable")
      ).toBe(true)
      const json = result.json as { oxlint: { config: string } }
      expect(json.oxlint.config).toBe("builtin")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unified mode human output surfaces a visible unknown diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-human-"))
    writeFileSync(
      join(dir, ".oxlintrc.json"),
      JSON.stringify({ rules: { "no-console": "error" } })
    )
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "plain.ts"), "console.log(\"x\")\n")
    try {
      const result = check({ projectDir: dir, cacheDir, mode: "unified" })
      expect(result.human.join("\n")).toContain(
        "diagnostic not in any provider catalog: eslint(no-console)"
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unified mode is read-only: no transient config left behind, project config unchanged", () => {
    const configPath = join(unifiedProject, ".oxlintrc.json")
    const before = readFileSync(configPath, "utf8")
    check({ projectDir: unifiedProject, cacheDir, mode: "unified" })
    const leftovers = readdirSync(unifiedProject).filter((f) =>
      f.startsWith(".effect-lens-check-oxlintrc-")
    )
    expect(leftovers).toEqual([])
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  it("lens-only mode uses the builtin config and does not preserve project ignores", () => {
    const result = check({ projectDir: unifiedProject, cacheDir, mode: "lens-only" })
    // ignored/b.ts IS linted in lens-only mode (the builtin config has no such ignore).
    expect(
      result.machineOutput.findings.some((f) => f.location.file.includes("ignored/b.ts"))
    ).toBe(true)
    const json = result.json as { oxlint: { config: string } }
    expect(json.oxlint.config).toBe("builtin")
  })
})
