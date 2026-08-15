/**
 * Tests for the read-only reference-pack baseline/status reporter
 * (`PackStatus.reportPackStatus`).
 *
 * These exercise the `PackBaselineStatus` contract against the committed cache
 * fixtures: absent, stale, corrupt, complete, mismatched, verified, and
 * unresolved, plus multiple versions, target-specific beta/RC selection, and
 * the read-only same-name candidate-baseline list. No cache or project file is
 * ever mutated; the tests assert the reporter never writes.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackPlan from "../src/PackPlan.ts"
import * as PackStatus from "../src/PackStatus.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const cacheMonoDir = fileURLToPath(new URL("./fixtures/cache-mono", import.meta.url))
const cacheStaleDir = fileURLToPath(new URL("./fixtures/cache-stale", import.meta.url))
const cachePartialDir = fileURLToPath(new URL("./fixtures/cache-partial", import.meta.url))
const emptyCacheDir = fileURLToPath(new URL("./fixtures/empty-cache", import.meta.url))
const monorepo = fileURLToPath(new URL("./fixtures/projects/monorepo", import.meta.url))
const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

const expected109 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "lockfile"
})
const expected100 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.100",
  source: "lockfile"
})

const upstream109 = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "deadbeef"
})
const upstream100 = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.100",
  commit: "bbbb"
})
const upstreamBeta83 = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-beta.83",
  commit: "beefcafe"
})

// Matches the committed cache/pack-effect-109 manifest exactly.
const catalogEntry109 = ReferencePack.makePackManifest({
  id: "pack-effect-109",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: expected109,
  upstream: upstream109,
  includedPaths: ["LLMS.md", "ai-docs/guide.md"],
  status: "complete"
})

// Same id/version but a divergent upstream commit: an intact exact local pack
// must NOT be reported `verified` against this baseline.
const catalogEntry109Divergent = ReferencePack.makePackManifest({
  id: "pack-effect-109",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: expected109,
  upstream: Provenance.makeUpstreamRef({
    repository: "effect-ts/effect",
    ref: "v4.0.0-rc.109",
    commit: "a-different-commit"
  }),
  includedPaths: ["LLMS.md", "ai-docs/guide.md"],
  status: "complete"
})

const catalogEntry100 = ReferencePack.makePackManifest({
  id: "pack-effect-100",
  effectVersion: "4.0.0-rc.100",
  packageIdentity: expected100,
  upstream: upstream100,
  includedPaths: ["LLMS.md"],
  status: "complete"
})

const catalogEntryBeta83 = ReferencePack.makePackManifest({
  id: "pack-effect-beta83",
  effectVersion: "4.0.0-beta.83",
  packageIdentity: PackageIdentity.makePackageIdentity({
    name: "effect",
    version: "4.0.0-beta.83",
    source: "lockfile"
  }),
  upstream: upstreamBeta83,
  includedPaths: ["LLMS.md"],
  status: "complete"
})

describe("reportPackStatus", () => {
  it("reports verified for an exact, intact pack matching the catalog baseline", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("verified")
    expect(Option.getOrNull(report.localPack)?.id).toBe("pack-effect-109")
    expect(Option.getOrNull(report.catalogEntry)?.id).toBe("pack-effect-109")
    expect(Option.isSome(report.baselineVerification)).toBe(true)
    expect(report.diagnostics).toEqual([])
    expect(report.candidateBaselines).toEqual([])
  })

  it("reports complete for an intact exact pack when no catalog baseline matches", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry100]
    })
    expect(report.status).toBe("complete")
    expect(Option.isNone(report.catalogEntry)).toBe(true)
    expect(Option.isNone(report.baselineVerification)).toBe(true)
    expect(report.diagnostics).toEqual([])
  })

  it("reports mismatched when the exact pack diverges from the catalog baseline", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry109Divergent]
    })
    expect(report.status).toBe("mismatched")
    const baseline = Option.getOrNull(report.baselineVerification)
    expect(baseline?.metadataChanged).toBe(true)
    expect(report.diagnostics.some((d) => d.id === "status-pack-mismatched")).toBe(true)
  })

  it("reports absent when no pack exists for the package", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: emptyCacheDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("absent")
    expect(Option.isNone(report.localPack)).toBe(true)
    // The exact baseline is still reported as available (not cached), so a
    // freshness slice can answer "what baseline is available?" for an absent
    // pack.
    expect(Option.getOrNull(report.catalogEntry)?.id).toBe("pack-effect-109")
    expect(report.diagnostics.some((d) => d.id === "status-pack-absent")).toBe(true)
  })

  it("reports stale when the only cached pack lags the exact version", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: cacheStaleDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("stale")
    expect(Option.getOrNull(report.localPack)?.id).toBe("pack-effect-100")
    expect(report.diagnostics.some((d) => d.id === "status-pack-stale")).toBe(true)
  })

  it("reports corrupt for an exact pack missing its own declared files", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: cachePartialDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("corrupt")
    const verification = Option.getOrNull(report.localVerification)
    expect(verification?.missingFiles.length ?? 0).toBeGreaterThan(0)
    expect(report.diagnostics.some((d) => d.id === "status-pack-corrupt")).toBe(true)
  })

  it("reports unresolved when no effect dependency is declared", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("missing-dependency"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("unresolved")
    expect(Option.isNone(report.expected)).toBe(true)
    expect(report.diagnostics.some((d) => d.id === "status-resolution-unavailable")).toBe(true)
  })

  it("reports unresolved for an inexact (range) declared specifier", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("unparseable-range"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("unresolved")
    expect(Option.getOrNull(report.expected)?.version).toBe("^4.0.0")
    expect(report.diagnostics.some((d) => d.id === "status-resolution-unavailable")).toBe(true)
  })

  it("reports unresolved for a workspace target with no importer", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      catalog: [catalogEntry109],
      workspace: "ghost"
    })
    expect(report.status).toBe("unresolved")
    expect(report.resolution.status).toBe("workspace-unresolved")
    expect(report.diagnostics.some((d) => d.id === "status-resolution-unavailable")).toBe(true)
  })

  it("reports verified for a target-specific beta pack and lists RC candidates", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      catalog: [catalogEntryBeta83, catalogEntry109, catalogEntry100],
      workspace: "packages/foldkit"
    })
    expect(report.resolution.status).toBe("resolved")
    expect(Option.getOrNull(report.expected)?.version).toBe("4.0.0-beta.83")
    expect(report.status).toBe("verified")
    expect(Option.getOrNull(report.localPack)?.id).toBe("pack-effect-beta83")
    // Candidates are the same-name (effect) catalog entries that are NOT the
    // exact target, sorted deterministically by id.
    expect(report.candidateBaselines.map((c) => c.id)).toEqual([
      "pack-effect-100",
      "pack-effect-109"
    ])
  })

  it("keeps multiple Effect versions side by side without cross-version lookup", () => {
    const foldkit = PackStatus.reportPackStatus({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      catalog: [catalogEntryBeta83, catalogEntry109],
      workspace: "packages/foldkit"
    })
    expect(Option.getOrNull(foldkit.localPack)?.id).toBe("pack-effect-beta83")
    expect(foldkit.status).toBe("verified")
  })

  it("reports corrupt for an rc workspace whose cached pack misses a declared file", () => {
    // cache-mono/pack-effect-109 declares ai-docs/guide.md but the fixture has
    // only LLMS.md, so the rc.109 workspace is genuinely incomplete.
    const report = PackStatus.reportPackStatus({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      catalog: [catalogEntryBeta83, catalogEntry109],
      workspace: "packages/docs"
    })
    expect(Option.getOrNull(report.expected)?.version).toBe("4.0.0-rc.109")
    expect(report.status).toBe("corrupt")
  })

  it("lists a same-name different-version catalog entry as a candidate baseline", () => {
    // cache holds both pack-effect-100 and pack-effect-109; the rc.109 target
    // selects 109 and surfaces 100 as the only same-name candidate baseline.
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry100, catalogEntry109]
    })
    expect(report.status).toBe("verified")
    expect(report.candidateBaselines.map((c) => c.id)).toEqual(["pack-effect-100"])
  })

  it("reports mismatched with a baseline-id message when the exact version is cached under a different id", () => {
    // cache-alt-id holds pack-effect-alt-109 (same rc.109 version, complete and
    // self-consistent) but the catalog baseline pins pack-effect-109. The
    // baseline id is not satisfied, so the report is mismatched and names the
    // unsatisfied baseline id rather than a generic missing-files message.
    const altCache = fileURLToPath(new URL("./fixtures/cache-alt-id", import.meta.url))
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: altCache,
      catalog: [catalogEntry109]
    })
    expect(report.status).toBe("mismatched")
    expect(Option.getOrNull(report.localPack)?.id).toBe("pack-effect-alt-109")
    expect(Option.getOrNull(report.catalogEntry)?.id).toBe("pack-effect-109")
    expect(Option.getOrNull(report.message) ?? "").toContain("pack-effect-109")
    expect(report.diagnostics.some((d) => d.id === "status-pack-mismatched")).toBe(true)
  })

  it("loads the committed catalog baseline and reports verified/absent/beta", () => {
    // The on-disk catalog fixtures are the baseline contract (DoD 1); loading
    // them through loadPackCatalog must produce the same statuses as the
    // in-memory catalogs above.
    const catalogDir = fileURLToPath(new URL("./fixtures/catalog", import.meta.url))
    const catalog = PackPlan.loadPackCatalog(catalogDir)
    expect(catalog.entries.length).toBeGreaterThanOrEqual(3)

    const verified = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog
    })
    expect(verified.status).toBe("verified")
    expect(Option.getOrNull(verified.catalogEntry)?.id).toBe("pack-effect-109")

    const absent = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: emptyCacheDir,
      catalog
    })
    expect(absent.status).toBe("absent")
    expect(Option.getOrNull(absent.catalogEntry)?.id).toBe("pack-effect-109")

    const beta = PackStatus.reportPackStatus({
      projectDir: monorepo,
      cacheDir: cacheMonoDir,
      catalog,
      workspace: "packages/foldkit"
    })
    expect(beta.status).toBe("verified")
    expect(Option.getOrNull(beta.localPack)?.id).toBe("pack-effect-beta83")
  })

  it("accepts an explicit PackCatalog baseline", () => {
    const report = PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: PackPlan.makePackCatalog({
        name: "baseline",
        baseline: "/nonexistent",
        entries: [catalogEntry100, catalogEntry109]
      })
    })
    expect(report.status).toBe("verified")
    expect(Option.getOrNull(report.catalogEntry)?.id).toBe("pack-effect-109")
  })

  it("never writes to the cache", () => {
    const cache = fileURLToPath(new URL("./fixtures/empty-cache", import.meta.url))
    PackStatus.reportPackStatus({
      projectDir: project("pnpm-valid"),
      cacheDir: cache,
      catalog: [catalogEntry109]
    })
    expect(existsSync(join(cache, "pack-effect-109"))).toBe(false)
    expect(existsSync(join(cache, "manifest.json"))).toBe(false)
  })
})
