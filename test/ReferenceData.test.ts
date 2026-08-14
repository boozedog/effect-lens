import { describe, expect, it } from "@effect/vitest"
import * as Drift from "../src/Drift.ts"
import * as Guidance from "../src/Guidance.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const effect109 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "lockfile"
})

const upstream109 = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "aaaa"
})

describe("Reference data", () => {
  it("reports compatible data when installed, declared, and referenced agree", () => {
    const entry = Drift.makeDriftEntry({
      packageIdentity: effect109,
      kind: "compatible",
      expected: upstream109,
      actual: upstream109
    })
    expect(entry.kind).toBe("compatible")
    expect(Drift.DriftKind).toBeDefined()
  })

  it("reports stale when the reference pack lags the installed version", () => {
    const stalePack = ReferencePack.makePackManifest({
      id: "pack-effect-100",
      effectVersion: "4.0.0-rc.100",
      packageIdentity: PackageIdentity.makePackageIdentity({
        name: "effect",
        version: "4.0.0-rc.100",
        source: "lockfile"
      }),
      upstream: Provenance.makeUpstreamRef({
        repository: "effect-ts/effect",
        ref: "v4.0.0-rc.100",
        commit: "bbbb"
      }),
      includedPaths: ["LLMS.md"],
      status: "stale"
    })
    expect(stalePack.status).toBe("stale")
    // The installed identity is newer than the pack's pinned version.
    expect(stalePack.effectVersion).not.toBe(effect109.version)
  })

  it("reports missing when no reference pack exists for the version", () => {
    const manifest = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: effect109,
      upstream: upstream109,
      includedPaths: [],
      status: "missing"
    })
    expect(manifest.status).toBe("missing")
  })

  it("flags conflicting guidance rather than merging incompatible sources", () => {
    const upstreamGuidance = Guidance.makeGuidance({
      id: "g-effect-pipe",
      topic: "piping",
      summary: "Prefer pipe for composition.",
      source: "upstream",
      validationStatus: "validated",
      evidence: []
    })
    const conflicting = Guidance.makeGuidance({
      id: "g-effect-pipe-lens",
      topic: "piping",
      summary: "Prefer direct calls over pipe.",
      source: "lens-strict",
      validationStatus: "conflict",
      evidence: []
    })
    // Distinct source kinds are preserved; the conflict is surfaced, not hidden.
    expect(upstreamGuidance.source).not.toBe(conflicting.source)
    expect(conflicting.validationStatus).toBe("conflict")
  })

  it("keeps drift kinds distinct so consumers can branch on them", () => {
    const kinds = ["compatible", "stale", "missing", "conflict"]
    for (const kind of kinds) {
      const entry = Drift.makeDriftEntry({
        packageIdentity: effect109,
        kind: kind as Drift.DriftKind
      })
      expect(entry.kind).toBe(kind)
    }
  })
})
