import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Resolver from "../src/Resolver.ts"

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

const MONOREPO = "monorepo"

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

describe("workspace-aware monorepo resolution", () => {
  it("does not assume the root importer owns effect when no target is given", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO))
    // The monorepo root importer has no effect; the root-only path cannot find
    // it, demonstrating why an explicit workspace target is required.
    expect(resolution.lockfile).toBe("pnpm-lock")
    expect(resolution.status).toBe("missing")
    expect(Option.isNone(resolution.expected)).toBe(true)
  })

  it("resolves a workspace target from the root lockfile without a missing-lockfile report", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "packages/foldkit"
    })
    expect(resolution.lockfile).toBe("pnpm-lock")
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-beta.83")
    expect(Option.getOrNull(resolution.expected)?.source).toBe("lockfile")
    expect(Option.getOrNull(resolution.installed)?.version).toBe("4.0.0-beta.83")
  })

  it("resolves a workspace target by basename", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "foldkit"
    })
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-beta.83")
  })

  it("supports multiple effect versions in one repository", () => {
    const foldkit = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "packages/foldkit"
    })
    const docs = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "packages/docs"
    })
    expect(Option.getOrNull(foldkit.expected)?.version).toBe("4.0.0-beta.83")
    expect(Option.getOrNull(docs.expected)?.version).toBe("4.0.0-rc.109")
  })

  it("resolves an exact version even when a same-name package key exists", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "packages/foldkit"
    })
    const integrity = Option.getOrNull(
      Option.getOrNull(resolution.expected)?.integrity ?? Option.none()
    )
    expect(integrity).toBe("sha512-beta83integrity")
  })

  it("reports an invalid workspace target as workspace-unresolved", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "does-not-exist"
    })
    expect(resolution.status).toBe("workspace-unresolved")
    expect(Option.getOrNull(resolution.detail)).toContain("does-not-exist")
  })

  it("does not fill expected from a non-importer package.json on an unresolved target", () => {
    // `ghost/` declares effect but is not a lockfile importer: the target must
    // not silently resolve from the guessed manifest.
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "ghost"
    })
    expect(resolution.status).toBe("workspace-unresolved")
    expect(Option.isNone(resolution.expected)).toBe(true)
  })

  it("resolves a nested importer path", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "packages/tools/kit"
    })
    expect(resolution.status).toBe("resolved")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-rc.109")
  })

  it("does not treat a multi-segment target as ambiguous against an unrelated basename", () => {
    // `tools/kit` has no exact importer and is multi-segment, so it must not
    // fall back to basename matching and collide with `apps/kit`.
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "tools/kit"
    })
    expect(resolution.status).toBe("workspace-unresolved")
  })

  it("reads the workspace-local installed package for a basename target", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "foldkit"
    })
    expect(Option.getOrNull(resolution.installed)?.version).toBe("4.0.0-beta.83")
    expect(Option.getOrNull(resolution.expected)?.version).toBe("4.0.0-beta.83")
  })

  it("reports an ambiguous workspace target as workspace-ambiguous", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "kit"
    })
    expect(resolution.status).toBe("workspace-ambiguous")
    expect(Option.getOrNull(resolution.detail)).toContain("packages/tools/kit")
    expect(Option.getOrNull(resolution.detail)).toContain("apps/kit")
  })

  it("rejects the root as a workspace target", () => {
    const resolution = Resolver.resolveEffectIdentity(fixture(MONOREPO), {
      workspace: "."
    })
    expect(resolution.status).toBe("workspace-unresolved")
  })

  it("parses a specific pnpm importer key", () => {
    const content = readFileSync(
      fileURLToPath(new URL(`./fixtures/projects/${MONOREPO}/pnpm-lock.yaml`, import.meta.url)),
      "utf8"
    )
    const identity = Resolver.parsePnpmLock(content, "packages/foldkit")
    expect(identity?.version).toBe("4.0.0-beta.83")
  })

  it("lists pnpm importer keys and matches targets", () => {
    const content = readFileSync(
      fileURLToPath(new URL(`./fixtures/projects/${MONOREPO}/pnpm-lock.yaml`, import.meta.url)),
      "utf8"
    )
    const keys = Resolver.pnpmImporterKeys(content)
    expect(keys).toContain(".")
    expect(keys).toContain("packages/foldkit")
    expect(Resolver.matchPnpmImporter(content, "packages/foldkit")).toEqual({
      key: "packages/foldkit"
    })
    expect(Resolver.matchPnpmImporter(content, "kit")).toHaveProperty("ambiguous")
    expect(Resolver.matchPnpmImporter(content, "nope")).toBeNull()
  })

  it("parses an npm workspace entry", () => {
    const npmWorkspace = JSON.stringify({
      name: "monorepo",
      lockfileVersion: 3,
      packages: {
        "": { name: "monorepo", version: "0.0.0" },
        "packages/foldkit": { name: "foldkit", dependencies: { effect: "4.0.0-beta.83" } },
        "packages/foldkit/node_modules/effect": { version: "4.0.0-beta.83" }
      }
    })
    const identity = Resolver.parsePackageLock(npmWorkspace, "packages/foldkit")
    expect(identity?.version).toBe("4.0.0-beta.83")
    expect(identity?.source).toBe("lockfile")
  })
})
