import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackVerifier from "../src/PackVerifier.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const cacheStaleDir = fileURLToPath(new URL("./fixtures/cache-stale", import.meta.url))
const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

const expected109 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "lockfile"
})

const upstream = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "deadbeef"
})

const manifest109 = ReferencePack.makePackManifest({
  id: "pack-effect-109",
  effectVersion: "4.0.0-rc.109",
  packageIdentity: expected109,
  upstream,
  includedPaths: ["LLMS.md", "ai-docs/guide.md"],
  status: "complete"
})

describe("findPack", () => {
  it("finds the pack matching the expected identity", () => {
    const pack = PackVerifier.findPack(cacheDir, expected109)
    expect(pack).not.toBeNull()
    expect(pack?.id).toBe("pack-effect-109")
  })

  it("returns null for a version mismatch (exact-match only)", () => {
    const expected200 = PackageIdentity.makePackageIdentity({
      name: "effect",
      version: "4.0.0-rc.200",
      source: "lockfile"
    })
    expect(PackVerifier.findPack(cacheDir, expected200)).toBeNull()
  })

  it("returns null when no pack exists for the package name", () => {
    const other = PackageIdentity.makePackageIdentity({
      name: "lodash",
      version: "4.17.21",
      source: "lockfile"
    })
    expect(PackVerifier.findPack(cacheDir, other)).toBeNull()
  })

  it("returns null for a missing cache directory", () => {
    expect(
      PackVerifier.findPack(
        fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url)),
        expected109
      )
    )
      .toBeNull()
  })
})

describe("verifyPack", () => {
  it("reports a complete pack with no missing files and no staleness", () => {
    const verification = PackVerifier.verifyPack({
      manifest: manifest109,
      expected: expected109,
      cacheDir
    })
    expect(verification.missingFiles).toEqual([])
    expect(verification.metadataChanged).toBe(false)
    expect(verification.stale).toBe(false)
    expect(Option.isNone(verification.message)).toBe(true)
  })

  it("reports missing files for a partial pack", () => {
    const partial = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: expected109,
      upstream,
      includedPaths: ["LLMS.md", "ai-docs/guide.md", "missing.md"],
      status: "complete"
    })
    const verification = PackVerifier.verifyPack({
      manifest: partial,
      expected: expected109,
      cacheDir
    })
    expect(verification.missingFiles).toEqual(["missing.md"])
    expect(Option.getOrNull(verification.message)).toContain("missing 1 file")
  })

  it("reports changed metadata when the baseline differs from the stored manifest", () => {
    const divergent = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: expected109,
      upstream: Provenance.makeUpstreamRef({
        repository: "effect-ts/effect",
        ref: "v4.0.0-rc.109",
        commit: "different-commit"
      }),
      includedPaths: ["LLMS.md", "ai-docs/guide.md"],
      status: "complete"
    })
    const verification = PackVerifier.verifyPack({
      manifest: divergent,
      expected: expected109,
      cacheDir
    })
    expect(verification.metadataChanged).toBe(true)
    expect(Option.getOrNull(verification.message)).toContain("metadata has changed")
  })

  it("reports staleness when the pack version lags the expected identity", () => {
    const stale = ReferencePack.makePackManifest({
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
      status: "complete"
    })
    const verification = PackVerifier.verifyPack({
      manifest: stale,
      expected: expected109,
      cacheDir
    })
    expect(verification.stale).toBe(true)
    expect(Option.getOrNull(verification.message)).toContain("expected 4.0.0-rc.109")
  })
})

describe("verifyReferencePack", () => {
  it("reports complete for a project with a matching, intact pack", () => {
    const result = PackVerifier.verifyReferencePack({ projectDir: project("pnpm-valid"), cacheDir })
    expect(result.status).toBe("complete")
    expect(Option.isSome(result.pack)).toBe(true)
    expect(Option.isSome(result.verification)).toBe(true)
  })

  it("reports missing when no pack exists in the cache", () => {
    const empty = fileURLToPath(new URL("./fixtures/empty-cache", import.meta.url))
    const result = PackVerifier.verifyReferencePack({
      projectDir: project("pnpm-valid"),
      cacheDir: empty
    })
    expect(result.status).toBe("missing")
    expect(Option.getOrNull(result.message)).toContain("no reference pack")
  })

  it("reports stale when the only pack lags the expected version", () => {
    const result = PackVerifier.verifyReferencePack({
      projectDir: project("pnpm-valid"),
      cacheDir: cacheStaleDir
    })
    expect(result.status).toBe("stale")
    expect(Option.getOrNull(result.message)).toContain("expected 4.0.0-rc.109")
  })

  it("reports missing when the project declares no effect dependency", () => {
    const result = PackVerifier.verifyReferencePack({
      projectDir: project("missing-dependency"),
      cacheDir
    })
    expect(result.status).toBe("missing")
    expect(Option.getOrNull(result.message)).toContain("no effect dependency")
  })
})
