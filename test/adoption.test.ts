/**
 * Tests for the read-only staged-adoption audit (`adoption audit`).
 *
 * These exercise the shared-core `buildAdoptionAudit` operation and the CLI
 * `adoptionAudit` adapter against the Foldstryx-style fixture, asserting the
 * JSON contract shape, human output, workspace selection, equivalent-rule
 * overlap detection, unified-gate findings, and the read-only guarantee (no
 * transient config left behind, no config mutation, no network/cache writes).
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { adoptionAudit } from "../src/cli/commands/adoption.ts"
import * as Adoption from "../src/operations/adoption.ts"

const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))
const cacheMonoDir = fileURLToPath(new URL("./fixtures/cache-mono", import.meta.url))
const adoptionFixture = project("adoption-foldstryx")

/**
 * A synchronous sleep used to poll for transient-config cleanup.
 *
 * @since 0.0.0
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Polls until no `.effect-lens-check-oxlintrc-*` transient config remains in
 * `dir`, or `timeoutMs` elapses. The audit runs oxlint in unified mode, which
 * writes a transient config into the project dir and removes it in a `finally`
 * block; a concurrent CLI subprocess may still be mid-run, so the read-only
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

describe("buildAdoptionAudit (operation)", () => {
  it("reports a resolved workspace with a complete pack and Foldstryx overlaps", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: null }
    })
    expect(audit.resolution.status).toBe("resolved")
    expect(Option.getOrNull(audit.resolution.expected)?.version).toBe("4.0.0-beta.83")
    expect(audit.pack.status).toBe("complete")
    expect(Option.getOrNull(audit.pack.pack)?.id).toBe("pack-effect-beta83")
    expect(Option.getOrNull(audit.workspace)).toBe("packages/foldkit")
    expect(audit.diagnostics).toHaveLength(0)
  })

  it("detects active providers and configured rules from the oxlint config", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: null }
    })
    const foldstryx = audit.providers.find((p) => p.provider === "foldstryx")
    expect(foldstryx?.active).toBe(true)
    expect(foldstryx?.rules).toContain("foldstryx/no-async-function")
    const stylex = audit.providers.find((p) => p.provider === "stylex")
    expect(stylex?.active).toBe(true)
    expect(stylex?.rules).toContain("stylex/valid-styles")
    const lens = audit.providers.find((p) => p.provider === "lens")
    expect(lens?.active).toBe(false)
    // The Lens provider always reports its catalog rules so the audit shows
    // the canonical rules available even when not configured.
    expect(lens?.rules).toContain("lens/no-async-function")
  })

  it("reports equivalent-rule overlaps for configured Foldstryx rules", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: null }
    })
    const providerRules = audit.overlaps.map((o) => o.providerRule)
    expect(providerRules).toContain("foldstryx/no-async-function")
    expect(providerRules).toContain("foldstryx/no-await-expression")
    expect(providerRules).toContain("foldstryx/no-new-promise")
    const asyncOverlap = audit.overlaps.find((o) =>
      o.providerRule === "foldstryx/no-async-function"
    )
    expect(asyncOverlap?.canonicalRule).toBe("lens/no-async-function")
  })

  it("reports the detected oxlint config scopes", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: null }
    })
    expect(Option.getOrNull(audit.oxlintScopes.configPath)).toBe(".oxlintrc.json")
    expect(audit.oxlintScopes.ignorePatterns).toContain("scripts/**")
    expect(audit.oxlintScopes.rules["foldstryx/no-async-function"]).toBe("error")
  })

  it("recommends canonical Lens migration while preserving project-specific rules", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: null }
    })
    const migrate = audit.recommendations.filter((r) => r.kind === "migrate-overlap")
    expect(migrate.length).toBe(3)
    expect(migrate.some((r) => r.message.includes("foldstryx/no-async-function"))).toBe(true)
    expect(migrate.some((r) => r.message.includes("lens/no-async-function"))).toBe(true)
    // The oxlint config has no Lens rules, so a configure-lens recommendation
    // is also present.
    expect(audit.recommendations.some((r) => r.kind === "configure-lens")).toBe(true)
  })

  it("reports a missing reference pack as a warning with a fetch-pack recommendation", () => {
    const emptyCache = mkdtempSync(join(tmpdir(), "effect-lens-adoption-emptycache-"))
    try {
      const audit = Adoption.buildAdoptionAudit({
        projectDir: adoptionFixture,
        cacheDir: emptyCache,
        workspace: "packages/foldkit",
        gate: { diagnostics: [], error: null }
      })
      expect(audit.pack.status).toBe("missing")
      expect(audit.diagnostics.some((d) => d.id === "adoption-pack-missing")).toBe(true)
      expect(audit.recommendations.some((r) => r.kind === "fetch-pack")).toBe(true)
    } finally {
      rmSync(emptyCache, { recursive: true, force: true })
    }
  })

  it("reports a missing effect dependency as a blocking error", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      gate: { diagnostics: [], error: null }
    })
    // Without a workspace target the root importer has no effect entry.
    expect(audit.resolution.status).toBe("missing")
    expect(audit.diagnostics.some((d) => d.id === "adoption-effect-missing")).toBe(true)
    expect(audit.recommendations.some((r) => r.kind === "resolve-dependency")).toBe(true)
  })

  it("reports an unresolved workspace target as a blocking error", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "does-not-exist",
      gate: { diagnostics: [], error: null }
    })
    expect(audit.resolution.status).toBe("workspace-unresolved")
    expect(audit.diagnostics.some((d) => d.id === "adoption-workspace-unresolved")).toBe(true)
  })

  it("reports an unparseable oxlint config as ambiguous with a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-adoption-badcfg-"))
    writeFileSync(join(dir, ".oxlintrc.json"), "not json")
    try {
      const audit = Adoption.buildAdoptionAudit({
        projectDir: dir,
        cacheDir: cacheMonoDir,
        gate: { diagnostics: [], error: null }
      })
      expect(audit.oxlint.status).toBe("ambiguous")
      expect(audit.diagnostics.some((d) => d.id === "adoption-oxlint-ambiguous")).toBe(true)
      expect(audit.recommendations.some((r) => r.kind === "configure-lens")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a missing oxlint config as missing with a configure-lens recommendation", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-adoption-nocfg-"))
    try {
      const audit = Adoption.buildAdoptionAudit({
        projectDir: dir,
        cacheDir: cacheMonoDir,
        gate: { diagnostics: [], error: null }
      })
      expect(audit.oxlint.status).toBe("missing")
      expect(Option.getOrNull(audit.oxlintScopes.configPath)).toBeNull()
      expect(audit.recommendations.some((r) => r.kind === "configure-lens")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("surfaces an unavailable gate as a warning diagnostic", () => {
    const audit = Adoption.buildAdoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit",
      gate: { diagnostics: [], error: "oxlint binary not found" }
    })
    expect(Option.getOrNull(audit.gate.error)).toBe("oxlint binary not found")
    expect(audit.diagnostics.some((d) => d.id === "adoption-gate-unavailable")).toBe(true)
  })
})

describe("adoptionAudit (CLI adapter)", () => {
  it("emits a JSON payload with the audit contract", () => {
    const result = adoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as {
      machineOutput: { status: number }
      audit: {
        project: string
        workspace: string | null
        resolution: { status: string; expected: { version: string } | null }
        pack: { status: string; pack: { id: string } | null }
        oxlint: { status: string }
        providers: Array<{ provider: string; active: boolean }>
        overlaps: Array<{ providerRule: string; canonicalRule: string }>
        gate: { summary: { total: number } }
        recommendations: Array<{ kind: string }>
      }
    }
    expect(json.machineOutput.status).toBe(0)
    expect(json.audit.project).toBe(adoptionFixture)
    expect(json.audit.workspace).toBe("packages/foldkit")
    expect(json.audit.resolution.status).toBe("resolved")
    expect(json.audit.resolution.expected?.version).toBe("4.0.0-beta.83")
    expect(json.audit.pack.status).toBe("complete")
    expect(json.audit.pack.pack?.id).toBe("pack-effect-beta83")
    expect(json.audit.oxlint.status).toBe("missing")
    expect(json.audit.providers.some((p) => p.provider === "foldstryx" && p.active)).toBe(true)
    expect(
      json.audit.overlaps.some((o) => o.providerRule === "foldstryx/no-async-function")
    ).toBe(true)
    expect(json.audit.recommendations.some((r) => r.kind === "migrate-overlap")).toBe(true)
  })

  it("reports current unified-gate findings and migration", () => {
    // A temp project with a Foldstryx plugin and an async source so the
    // unified gate produces a Lens finding and a migration entry.
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-adoption-gate-"))
    try {
      writeFileSync(
        join(dir, ".oxlintrc.json"),
        JSON.stringify({
          jsPlugins: [join(adoptionFixture, "foldstryx-plugin.ts")],
          rules: { "foldstryx/no-async-function": "error" }
        })
      )
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "src", "a.ts"), "async function foo() {\n  return 1\n}\nvoid foo\n")
      const result = adoptionAudit({ projectDir: dir, cacheDir: cacheMonoDir })
      expect(result.machineOutput.status).toBe(2)
      const json = result.json as {
        machineOutput: { status: number; diagnostics: Array<{ id: string }> }
        audit: {
          gate: {
            findings: Array<{
              rule: string
              provider: string | null
              appliesTo: unknown
              location: { file: string; line: number; column: number | null }
            }>
            migration: Array<{ providerRule: string; canonicalRule: string }>
            diagnostics: Array<{ id: string }>
            summary: { total: number }
          }
        }
      }
      // The unified gate loads the Lens plugin alongside the Foldstryx plugin,
      // so the async function in src/a.ts produces a Lens finding and a
      // migration entry for the redundant Foldstryx rule.
      expect(json.audit.gate.findings.some((f) => f.rule === "lens/no-async-function")).toBe(true)
      expect(
        json.audit.gate.migration.some(
          (m) => m.providerRule === "foldstryx/no-async-function"
        )
      ).toBe(true)
      expect(json.audit.gate.summary.total).toBeGreaterThan(0)
      // The gate findings must encode with the stable JSON contract: the
      // provider is a plain string (not an Effect Option _tag object), the
      // absent appliesTo is null, and the location column is a number.
      const finding = json.audit.gate.findings[0]
      expect(finding.provider).toBe("lens")
      expect(finding.appliesTo).toBeNull()
      expect(typeof finding.location.column).toBe("number")
      // The blocking gate error is reflected in the machine output status, and
      // the per-location migration note is surfaced in the gate diagnostics.
      expect(json.machineOutput.status).toBe(2)
      expect(
        json.audit.gate.diagnostics.some((d) => d.id.startsWith("review-migration-"))
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits concise human-readable output with the key sections", () => {
    const result = adoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    const human = result.human.join("\n")
    expect(result.human[0]).toBe("effect-lens adoption audit")
    expect(human).toContain("workspace: packages/foldkit")
    expect(human).toContain("effect: 4.0.0-beta.83")
    expect(human).toContain("reference pack: complete")
    expect(human).toContain("providers:")
    expect(human).toContain("foldstryx [active]")
    expect(human).toContain("equivalent-rule overlaps:")
    expect(human).toContain("foldstryx/no-async-function → lens/no-async-function")
    expect(human).toContain("unified gate:")
    expect(human).toContain("recommendations:")
    expect(human).toContain("note: audit only; no files were changed")
  })

  it("is read-only: no transient config left behind and the project config is unchanged", () => {
    const configPath = join(adoptionFixture, ".oxlintrc.json")
    const before = readFileSync(configPath, "utf8")
    adoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    expect(waitForNoTransient(adoptionFixture)).toBe(true)
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  it("is read-only: the reference-pack cache is not mutated", () => {
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh array
    const cacheBefore = readdirSync(cacheMonoDir).sort()
    adoptionAudit({
      projectDir: adoptionFixture,
      cacheDir: cacheMonoDir,
      workspace: "packages/foldkit"
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh array
    expect(readdirSync(cacheMonoDir).sort()).toEqual(cacheBefore)
  })
})
