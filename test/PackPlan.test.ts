import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackPlan from "../src/PackPlan.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const cacheStaleDir = fileURLToPath(new URL("./fixtures/cache-stale", import.meta.url))
const cachePartialDir = fileURLToPath(new URL("./fixtures/cache-partial", import.meta.url))
const emptyCacheDir = fileURLToPath(new URL("./fixtures/empty-cache", import.meta.url))
const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

const expected109 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
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

// Matches the committed fixture cache/pack-effect-109 manifest exactly so a
// complete local pack is genuinely "already complete" against this baseline.
const catalogEntry109 = ReferencePack.makePackManifest({
  id: "pack-effect-109",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: expected109,
  upstream: upstream109,
  includedPaths: ["LLMS.md", "ai-docs/guide.md"],
  status: "complete"
})

// Same id/version but a divergent upstream commit: a present exact pack must
// NOT be reported done against this baseline.
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

// A catalog entry carrying integrity/sourceUrl/attribution, to prove the plan
// preserves that data (used where no exact local pack triggers a comparison).
const catalogEntry109Rich = ReferencePack.makePackManifest({
  id: "pack-effect-109",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: PackageIdentity.makePackageIdentity({
    name: "effect",
    version: "4.0.0-rc.109",
    source: "lockfile",
    integrity:
      "sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA=="
  }),
  upstream: upstream109,
  includedPaths: ["LLMS.md", "ai-docs/guide.md"],
  sourceUrl: "https://github.com/effect-ts/effect",
  attribution: new Provenance.Attribution({
    license: Option.none(),
    copyright: Option.none(),
    notice: Option.some("MIT (c) effect-ts")
  }),
  status: "complete"
})

const catalogEntry100 = ReferencePack.makePackManifest({
  id: "pack-effect-100",
  effectVersion: "4.0.0-rc.100",
  packageIdentity: PackageIdentity.makePackageIdentity({
    name: "effect",
    version: "4.0.0-rc.100",
    source: "lockfile"
  }),
  upstream: upstream100,
  includedPaths: ["LLMS.md"],
  status: "complete"
})

describe("selectCatalogEntry", () => {
  it("selects the exact name+version match", () => {
    const entry = PackPlan.selectCatalogEntry([catalogEntry100, catalogEntry109], expected109)
    expect(entry?.id).toBe("pack-effect-109")
  })

  it("returns null for an exact-version miss, never a compatible/newer pick", () => {
    const newer = PackageIdentity.makePackageIdentity({
      name: "effect",
      version: "4.0.0-rc.200",
      source: "lockfile"
    })
    expect(PackPlan.selectCatalogEntry([catalogEntry100, catalogEntry109], newer)).toBeNull()
    expect(PackPlan.selectCatalogEntry([catalogEntry100], expected109)).toBeNull()
  })
})

describe("planPackAcquisition", () => {
  it("plans already-complete for an exact, intact local pack matching the catalog", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("already-complete")
    expect(Option.isSome(plan.catalogEntry)).toBe(true)
    expect(Option.isSome(plan.localPack)).toBe(true)
    expect(Option.getOrNull(plan.expected)?.version).toBe("4.0.0-rc.109")
    expect(plan.steps[0].action).toBe("already-complete")
    expect(plan.diagnostics).toEqual([])
  })

  it("plans already-complete for an exact, intact local pack even without a catalog entry", () => {
    // Documented rule: presence beats source; the catalog only gates acquisition.
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry100]
    })
    expect(plan.action).toBe("already-complete")
    expect(Option.isNone(plan.catalogEntry)).toBe(true)
    expect(plan.diagnostics).toEqual([])
    expect(plan.steps.some((s) => s.action === "stale-pack-present")).toBe(false)
  })

  it("does not report an intact exact pack as stale when the catalog entry is missing", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: []
    })
    expect(plan.action).toBe("already-complete")
    expect(plan.diagnostics.some((d) => d.id === "plan-stale-pack-present")).toBe(false)
  })

  it("plans partial-pack-present when the exact local pack diverges from the catalog", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: [catalogEntry109Divergent]
    })
    expect(plan.action).toBe("partial-pack-present")
    expect(Option.isSome(plan.localPack)).toBe(true)
    expect(Option.isSome(plan.verification)).toBe(true)
    expect(plan.diagnostics[0]?.id).toBe("plan-partial-pack-present")
  })

  it("plans fetch-required only when an explicit catalog source exists", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: emptyCacheDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("fetch-required")
    expect(Option.isNone(plan.localPack)).toBe(true)
    expect(Option.getOrNull(plan.catalogEntry)?.id).toBe("pack-effect-109")
    expect(plan.steps[0].action).toBe("fetch-required")
  })

  it("preserves version/upstream/integrity/paths in the selected catalog entry", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: emptyCacheDir,
      catalog: [catalogEntry109Rich]
    })
    const entry = Option.getOrNull(plan.catalogEntry)
    expect(plan.action).toBe("fetch-required")
    expect(Option.getOrNull(entry?.packageIdentity.integrity ?? Option.none())).toBe(
      "sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA=="
    )
    expect(Option.getOrNull(entry?.sourceUrl ?? Option.none())).toBe(
      "https://github.com/effect-ts/effect"
    )
    expect(entry?.includedPaths).toEqual(["LLMS.md", "ai-docs/guide.md"])
    expect(Option.getOrNull(entry?.upstream.commit ?? Option.none())).toBe("deadbeef")
    const attribution = Option.getOrNull(entry?.attribution ?? Option.none())
    expect(Option.getOrNull(attribution?.notice ?? Option.none())).toBe("MIT (c) effect-ts")
  })

  it("plans stale-pack-present when the only cached pack lags and a catalog entry exists", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: cacheStaleDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("stale-pack-present")
    expect(Option.getOrNull(plan.localPack)?.id).toBe("pack-effect-100")
    expect(Option.isSome(plan.catalogEntry)).toBe(true)
    expect(plan.diagnostics.length).toBeGreaterThan(0)
  })

  it("plans partial-pack-present for an exact pack missing files on disk", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: cachePartialDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("partial-pack-present")
    expect(Option.isSome(plan.localPack)).toBe(true)
    const verification = Option.getOrNull(plan.verification)
    expect(verification?.missingFiles.length ?? 0).toBeGreaterThan(0)
  })

  it("plans catalog-entry-missing when no catalog entry provides the exact version", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: emptyCacheDir,
      catalog: [catalogEntry100]
    })
    expect(plan.action).toBe("catalog-entry-missing")
    expect(Option.isNone(plan.catalogEntry)).toBe(true)
    expect(plan.diagnostics[0]?.id).toBe("plan-catalog-entry-missing")
  })

  it("surfaces a genuinely stale cached pack even when the catalog entry is missing", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir: cacheStaleDir,
      catalog: [catalogEntry100]
    })
    expect(plan.action).toBe("catalog-entry-missing")
    expect(Option.getOrNull(plan.localPack)?.id).toBe("pack-effect-100")
    expect(plan.diagnostics.some((d) => d.id === "plan-stale-pack-present")).toBe(true)
    expect(plan.steps.some((s) => s.action === "stale-pack-present")).toBe(true)
  })

  it("plans resolution-unavailable when no effect dependency is declared", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("missing-dependency"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("resolution-unavailable")
    expect(Option.isNone(plan.expected)).toBe(true)
    expect(plan.diagnostics[0]?.severity).toBe("error")
  })

  it("plans resolution-unavailable for an inexact (range) declared specifier", () => {
    // unparseable-range declares effect ^4.0.0; a range can never select an
    // exact catalog entry, so the outcome is resolution-unavailable, not a
    // confusing catalog-entry-missing.
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("unparseable-range"),
      cacheDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("resolution-unavailable")
    expect(Option.getOrNull(plan.expected)?.version).toBe("^4.0.0")
    expect(Option.isNone(plan.catalogEntry)).toBe(true)
    expect(plan.diagnostics[0]?.id).toBe("plan-resolution-unavailable")
  })

  it("plans fetch-required for an exact declared version even without a supported lockfile", () => {
    // unsupported-lockfile pins an exact version in package.json, so acquisition
    // can be planned against an explicit catalog entry.
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("unsupported-lockfile"),
      cacheDir: emptyCacheDir,
      catalog: [catalogEntry109]
    })
    expect(plan.action).toBe("fetch-required")
  })

  it("accepts an explicit PackCatalog baseline", () => {
    const plan = PackPlan.planPackAcquisition({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalog: PackPlan.makePackCatalog({
        name: "baseline",
        baseline: "/nonexistent",
        entries: [catalogEntry100, catalogEntry109]
      })
    })
    expect(plan.action).toBe("already-complete")
    expect(Option.getOrNull(plan.catalogEntry)?.id).toBe("pack-effect-109")
  })
})

describe("loadPackCatalog", () => {
  it("loads every decodable manifest from a baseline directory", () => {
    const catalog = PackPlan.loadPackCatalog(cacheDir)
    expect(catalog.entries.length).toBeGreaterThanOrEqual(2)
    expect(catalog.entries.some((e) => e.id === "pack-effect-109")).toBe(true)
    expect(catalog.entries.some((e) => e.id === "pack-effect-100")).toBe(true)
  })

  it("returns an empty catalog for a missing baseline directory", () => {
    const catalog = PackPlan.loadPackCatalog(
      fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url))
    )
    expect(catalog.entries).toEqual([])
  })
})
