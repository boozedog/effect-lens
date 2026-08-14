import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import * as Resolver from "../src/Resolver.ts"

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

const pnpmLock = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

packages:

  effect@4.0.0-rc.109:
    resolution: {integrity: sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA==}
    dependencies:
      fast-check: 4.9.0
`

const npmLock = JSON.stringify({
  name: "fixture",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "fixture",
      version: "0.0.0",
      devDependencies: { effect: "4.0.0-rc.109" }
    },
    "node_modules/effect": {
      version: "4.0.0-rc.109",
      integrity:
        "sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA=="
    }
  }
})

describe("Resolver parsers", () => {
  it("parses a pnpm lockfile and merges duplicate package keys for integrity", () => {
    const identity = Resolver.parsePnpmLock(pnpmLock)
    expect(identity).not.toBeNull()
    expect(identity?.name).toBe("effect")
    expect(identity?.version).toBe("4.0.0-rc.109")
    expect(identity?.source).toBe("lockfile")
    expect(Option.getOrNull(identity?.integrity ?? Option.none())).toBe(
      "sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA=="
    )
  })

  it("parses an npm package-lock.json", () => {
    const identity = Resolver.parsePackageLock(npmLock)
    expect(identity?.name).toBe("effect")
    expect(identity?.version).toBe("4.0.0-rc.109")
    expect(identity?.source).toBe("lockfile")
  })

  it("returns null for a lockfile without an effect entry", () => {
    expect(
      Resolver.parsePnpmLock(
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      typescript:\n        version: 5.9.3\n"
      )
    ).toBeNull()
    expect(Resolver.parsePackageLock(JSON.stringify({ packages: {} }))).toBeNull()
  })

  it("ignores a transitive hoisted effect copy in an npm lockfile", () => {
    const transitiveOnly = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "0.0.0" },
        "node_modules/effect": { version: "4.0.0-rc.109" }
      }
    })
    expect(Resolver.parsePackageLock(transitiveOnly)).toBeNull()
  })

  it("detects an unparseable pnpm lockfile shape", () => {
    expect(
      Resolver.isParseablePnpmLock("lockfileVersion: 5.4\ndependencies:\n  effect: 4.0.0-rc.109\n")
    ).toBe(
      false
    )
    expect(Resolver.isParseablePackageLock("not json")).toBe(false)
  })

  it("parses a package.json declared specifier", () => {
    const identity = Resolver.parsePackageJson(
      JSON.stringify({ devDependencies: { effect: "4.0.0-rc.109" } })
    )
    expect(identity?.version).toBe("4.0.0-rc.109")
    expect(identity?.source).toBe("package.json")
  })

  it("parses an installed effect package.json", () => {
    const identity = Resolver.parseInstalledPackageJson(
      JSON.stringify({ name: "effect", version: "4.0.0-rc.109" })
    )
    expect(identity?.version).toBe("4.0.0-rc.109")
    expect(identity?.source).toBe("installed")
  })
})

describe("resolveEffectIdentity", () => {
  it("resolves a valid pnpm project as resolved", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("pnpm-valid"))
    expect(resolution.lockfile).toBe("pnpm-lock")
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(resolution.installed)?.version).toBe("4.0.0-rc.109")
  })

  it("resolves a valid npm project as resolved", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("npm-valid"))
    expect(resolution.lockfile).toBe("package-lock")
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-rc.109")
  })

  it("falls back to package.json when no lockfile exists", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("missing-lockfile"))
    expect(resolution.lockfile).toBe("missing")
    expect(resolution.status).toBe("missing-lockfile")
    expect(Option.getOrNull(resolution.expected)?.source).toBe("package.json")
  })

  it("reports an installed-version mismatch as a conflict", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("installed-mismatch"))
    expect(resolution.status).toBe("installed-mismatch")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(resolution.installed)?.version).toBe("4.0.0-rc.100")
  })

  it("reports an unsupported lockfile explicitly rather than guessing", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("unsupported-lockfile"))
    expect(resolution.lockfile).toBe("yarn-lock")
    expect(resolution.status).toBe("unsupported-lockfile")
    expect(Option.getOrNull(resolution.expected)?.source).toBe("package.json")
  })

  it("reports a bun lockfile as unsupported", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("bun-lockfile"))
    expect(resolution.lockfile).toBe("bun-lock")
    expect(resolution.status).toBe("unsupported-lockfile")
    expect(Option.getOrNull(resolution.expected)?.source).toBe("package.json")
  })

  it("reports missing when no effect dependency is declared", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("missing-dependency"))
    expect(resolution.status).toBe("missing")
    expect(Option.isNone(resolution.expected)).toBe(true)
  })

  it("reports an unparseable lockfile distinctly rather than as a version conflict", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("unparseable-lockfile"))
    expect(resolution.lockfile).toBe("pnpm-lock")
    expect(resolution.status).toBe("missing-lockfile")
    expect(Option.getOrNull(resolution.expected)?.source).toBe("package.json")
    expect(Option.getOrNull(resolution.detail)).toContain("could not be parsed")
  })

  it("does not report a range specifier as an installed-version conflict when the lockfile is unparseable", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture("unparseable-range"))
    expect(resolution.status).toBe("missing-lockfile")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("^4.0.0")
    expect(Option.getOrNull(resolution.installed)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(resolution.detail)).toContain("could not be parsed")
  })

  it("dogfoods the real repository lockfile", () => {
    const resolution = Resolver.resolveEffectIdentity(process.cwd())
    expect(resolution.lockfile).toBe("pnpm-lock")
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(resolution.expected)?.integrity).toEqual(
      Option.some(
        "sha512-6ubcOCtfdbmFO5+vgcT2HsTw5s+n3aMUj4eAIbVpUxP7+VYCwXxxcBHgiWgizOrGO1eGmuOBFek3mM0dFcwaWA=="
      )
    )
  })
})
