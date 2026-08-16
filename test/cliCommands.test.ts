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
const foldstryxPlugin = fileURLToPath(
  new URL("./fixtures/projects/check-foldstryx/foldstryx-plugin.ts", import.meta.url)
)
const stylexPlugin = fileURLToPath(
  new URL("./fixtures/projects/check-stylex/stylex-plugin.ts", import.meta.url)
)

/**
 * A synchronous sleep used to poll for transient-config cleanup. `Atomics.wait`
 * blocks the current thread without busy-spinning the CPU.
 *
 * @since 0.0.0
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Polls until no `.effect-lens-check-oxlintrc-*` transient config remains in
 * `dir`, or `timeoutMs` elapses. The `check` command writes a transient config
 * into the project dir and removes it in a `finally` block; a concurrent CLI
 * subprocess (e.g. `test/cli.test.ts`) may still be mid-run, so the read-only
 * guarantee is asserted by polling rather than a single racy snapshot.
 *
 * @since 0.0.0
 */
const waitForNoTransient = (dir: string, timeoutMs = 5000): boolean => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(".effect-lens-check-oxlintrc-"))
    if (leftovers.length === 0) return true
    sleepSync(50)
  }
  return readdirSync(dir).filter((f) => f.startsWith(".effect-lens-check-oxlintrc-")).length === 0
}

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
    expect(json.report.toolchain.lensVersion).toBe("0.1.0")
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
    // Poll for cleanup: a concurrent CLI subprocess may still be mid-run.
    expect(waitForNoTransient(unifiedProject)).toBe(true)
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

  it("unified mode dedups equivalent Foldstryx diagnostics and reports migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-foldstryx-"))
    try {
      writeFileSync(
        join(dir, ".oxlintrc.json"),
        JSON.stringify({
          jsPlugins: [foldstryxPlugin],
          rules: { "foldstryx/no-async-function": "error" }
        })
      )
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "src", "a.ts"), "async function foo() {\n  return 1\n}\nvoid foo\n")
      const result = check({ projectDir: dir, cacheDir, mode: "unified" })
      // The Lens rule fires on src/a.ts; the Foldstryx rule fires on the same
      // location, so the two collapse to one Lens finding.
      const asyncFindings = result.machineOutput.findings.filter(
        (f) => f.rule === "lens/no-async-function"
      )
      // Exactly one async function in the fixture → exactly one Lens finding.
      expect(asyncFindings.length).toBe(1)
      // No duplicate Foldstryx finding: every Foldstryx diagnostic is redundant.
      expect(
        result.machineOutput.findings.some((f) => Option.getOrNull(f.provider) === "foldstryx")
      ).toBe(false)
      // A migration diagnostic explains the overlap.
      expect(
        result.machineOutput.diagnostics.some((d) => d.id.startsWith("review-migration-"))
      ).toBe(true)
      // The migration report lists the redundant Foldstryx rules.
      const json = result.json as {
        review: { migration: { entries: Array<{ providerRule: string; canonicalRule: string }> } }
      }
      const entries = json.review.migration.entries
      expect(entries.some((e) => e.providerRule === "foldstryx/no-async-function")).toBe(true)
      expect(entries.some((e) => e.canonicalRule === "lens/no-async-function")).toBe(true)
      // The human output surfaces the migration section.
      expect(result.human.join("\n")).toContain("migration:")
      expect(result.human.join("\n")).toContain("foldstryx/no-async-function")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unified mode surfaces StyleX findings with stylex provenance and project source", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-stylex-"))
    try {
      writeFileSync(
        join(dir, ".oxlintrc.json"),
        JSON.stringify({
          jsPlugins: [stylexPlugin],
          rules: { "stylex/valid-styles": "error", "stylex/sort-keys": "warn" }
        })
      )
      mkdirSync(join(dir, "src"))
      writeFileSync(
        join(dir, "src", "a.ts"),
        "import * as stylex from '@stylexjs/stylex'\n" +
          "const styles = stylex.create({ root: { color: 'red' } })\n" +
          "void styles\n"
      )
      const result = check({ projectDir: dir, cacheDir, mode: "unified" })
      // The StyleX provider recognizes the stylex(...) codes and keeps them
      // as findings with stylex provenance and project source.
      const stylexFindings = result.machineOutput.findings.filter(
        (f) => Option.getOrNull(f.provider) === "stylex"
      )
      expect(stylexFindings.length).toBeGreaterThan(0)
      expect(stylexFindings.every((f) => f.source === "project")).toBe(true)
      expect(stylexFindings.some((f) => f.rule === "stylex/valid-styles")).toBe(true)
      // Warning severity is preserved: the error rule stays blocking and the
      // warn rule stays advisory.
      expect(stylexFindings.some((f) => f.rule === "stylex/valid-styles" && f.severity === "error"))
        .toBe(
          true
        )
      expect(stylexFindings.some((f) => f.rule === "stylex/sort-keys" && f.severity === "warning"))
        .toBe(
          true
        )
      // The aggregate status reflects the blocking StyleX error.
      expect(result.machineOutput.status).toBe(2)
      // No migration: StyleX rules have no Lens equivalent.
      const json = result.json as {
        review: { migration: { entries: Array<{ providerRule: string }> } }
      }
      expect(json.review.migration.entries.some((e) => e.providerRule.startsWith("stylex/"))).toBe(
        false
      )
      // The human output surfaces the StyleX findings.
      expect(result.human.join("\n")).toContain("stylex/valid-styles")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A pnpm lockfile declaring the root importer plus `packages/foldkit`
 * (unique basename `foldkit`) and two `.../kit` importers (`kit` is an
 * ambiguous basename target).
 *
 * @since 0.0.0
 */
const workspaceLock = (): string =>
  `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.3

  packages/foldkit:
    dependencies:
      effect:
        specifier: 4.0.0-beta.83
        version: 4.0.0-beta.83

  packages/tools/kit:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

  apps/kit:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

packages:

  effect@4.0.0-beta.83:
    resolution: {integrity: sha512-beta83}
    dependencies:
      fast-check: 4.9.0

  effect@4.0.0-rc.109:
    resolution: {integrity: sha512-rc109}
    dependencies:
      fast-check: 4.9.0
`

describe("check full-check workspace scope", () => {
  /**
   * Creates a temporary pnpm monorepo with a root file outside any workspace
   * and an async function inside `packages/foldkit`. Both would trigger
   * `lens/no-async-function`, so a workspace-scoped run lints only the
   * workspace copy.
   *
   * @since 0.0.0
   */
  const workspaceProject = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-checkws-"))
    writeFileSync(join(dir, "pnpm-lock.yaml"), workspaceLock())
    mkdirSync(join(dir, "src"))
    writeFileSync(
      join(dir, "src", "root.ts"),
      "async function rootFn() {\n  return 1\n}\nvoid rootFn\n"
    )
    mkdirSync(join(dir, "packages", "foldkit", "src"), { recursive: true })
    writeFileSync(
      join(dir, "packages", "foldkit", "src", "lib.ts"),
      "async function libFn() {\n  return 2\n}\nvoid libFn\n"
    )
    return dir
  }

  it("full unified check with --workspace lints only the selected workspace, excluding root files", () => {
    const dir = workspaceProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        mode: "unified",
        workspace: "packages/foldkit"
      })
      // Only the foldkit workspace is linted: its async function is a finding.
      expect(
        result.machineOutput.findings.some((f) =>
          f.location.file.includes("packages/foldkit/src/lib.ts")
        )
      ).toBe(true)
      // The root file is outside the workspace and must not be linted.
      expect(
        result.machineOutput.findings.some((f) => f.location.file.includes("src/root.ts"))
      ).toBe(false)
      const json = result.json as {
        scope: { kind: string; workspace: string; workspaceDir: string | null }
        oxlint: { config: string }
      }
      expect(json.scope.kind).toBe("project")
      expect(json.scope.workspace).toBe("packages/foldkit")
      expect(json.scope.workspaceDir).toBe("packages/foldkit")
      // No project oxlint config in the temp fixture, so unified mode falls
      // back to the built-in config; the important point is oxlint DID run on
      // the workspace scope (not the "none" used for a blocked run).
      expect(json.oxlint.config).not.toBe("none")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves a valid basename workspace target for full check", () => {
    const dir = workspaceProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        mode: "unified",
        workspace: "foldkit"
      })
      expect(
        result.machineOutput.findings.some((f) =>
          f.location.file.includes("packages/foldkit/src/lib.ts")
        )
      ).toBe(true)
      const json = result.json as {
        scope: { kind: string; workspace: string; workspaceDir: string | null }
      }
      expect(json.scope.kind).toBe("project")
      expect(json.scope.workspace).toBe("foldkit")
      expect(json.scope.workspaceDir).toBe("packages/foldkit")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an unresolved workspace target with a blocking diagnostic and no oxlint run", () => {
    const dir = workspaceProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        mode: "unified",
        workspace: "does-not-exist"
      })
      expect(
        result.machineOutput.diagnostics.some(
          (d) => d.id === "check-workspace-unresolved" && d.severity === "error"
        )
      ).toBe(true)
      // oxlint is never spawned: config source is none and zero files.
      const json = result.json as {
        scope: { error: string | null; errorKind: string | null }
        oxlint: { files: number; config: string }
      }
      expect(json.scope.errorKind).toBe("unresolved")
      expect(json.scope.error).toContain("does-not-exist")
      expect(json.oxlint.files).toBe(0)
      expect(json.oxlint.config).toBe("none")
      expect(result.machineOutput.findings).toHaveLength(0)
      // The blocking diagnostic drives a blocking exit status.
      expect(result.machineOutput.status).toBe(2)
      expect(result.human.join("\n")).toContain("workspace: does-not-exist")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an ambiguous workspace target with a blocking diagnostic and no oxlint run", () => {
    const dir = workspaceProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        mode: "unified",
        workspace: "kit"
      })
      expect(
        result.machineOutput.diagnostics.some(
          (d) => d.id === "check-workspace-ambiguous" && d.severity === "error"
        )
      ).toBe(true)
      const json = result.json as {
        scope: { error: string | null; errorKind: string | null }
        oxlint: { files: number; config: string }
      }
      expect(json.scope.errorKind).toBe("ambiguous")
      expect(json.scope.error).toContain("packages/tools/kit")
      expect(json.scope.error).toContain("apps/kit")
      expect(json.oxlint.files).toBe(0)
      expect(json.oxlint.config).toBe("none")
      expect(result.machineOutput.findings).toHaveLength(0)
      // The blocking diagnostic drives a blocking exit status.
      expect(result.machineOutput.status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an explicit --path wins over --workspace for the lint scope", () => {
    const dir = workspaceProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        mode: "unified",
        workspace: "packages/foldkit",
        path: "src"
      })
      // The explicit path targets the root `src/` (root.ts), so the root file
      // is linted and the workspace file is not.
      expect(
        result.machineOutput.findings.some((f) => f.location.file.includes("src/root.ts"))
      ).toBe(true)
      expect(
        result.machineOutput.findings.some((f) => f.location.file.includes("foldkit"))
      ).toBe(false)
      const json = result.json as { scope: { kind: string; path: string; workspace: string } }
      expect(json.scope.kind).toBe("path")
      expect(json.scope.path).toBe("src")
      expect(json.scope.workspace).toBe("packages/foldkit")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
