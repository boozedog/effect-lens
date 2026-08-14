import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"

const lockfileIdentity = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "lockfile",
  integrity: "sha512-abc"
})

const installedIdentity = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "installed"
})

const upstream = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "9f2a1c4e"
})

describe("PackageIdentity", () => {
  it("distinguishes package identity from upstream commit identity", () => {
    // Lockfile identity is a PackageIdentity, upstream is an UpstreamRef.
    expect(lockfileIdentity).toBeInstanceOf(PackageIdentity.PackageIdentity)
    expect(upstream).toBeInstanceOf(Provenance.UpstreamRef)
    // They carry different facts about the same dependency.
    expect(lockfileIdentity.version).toBe("4.0.0-rc.109")
    expect(lockfileIdentity.integrity).toEqual(Option.some("sha512-abc"))
    expect(upstream.commit).toEqual(Option.some("9f2a1c4e"))
    expect(upstream.repository).toBe("effect-ts/effect")
  })

  it("treats same name+version as the same package regardless of source", () => {
    expect(PackageIdentity.samePackage(lockfileIdentity, installedIdentity)).toBe(true)
  })

  it("treats differing versions as different packages", () => {
    const older = PackageIdentity.makePackageIdentity({
      name: "effect",
      version: "4.0.0-rc.100",
      source: "lockfile"
    })
    expect(PackageIdentity.samePackage(lockfileIdentity, older)).toBe(false)
  })

  it("rejects a package identity with an empty version", () => {
    const bad = { name: "effect", version: "", source: "lockfile" }
    expect(Option.isNone(Schema.decodeUnknownOption(PackageIdentity.PackageIdentity)(bad))).toBe(
      true
    )
  })
})
