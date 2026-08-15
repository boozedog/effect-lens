/**
 * Tests for the read-only freshness recommendation (issue #15).
 *
 * These exercise the pure policy logic and {@link computeFreshnessRecommendation}
 * with deterministic, injected registry snapshots, policies, and clocks — no
 * network access is required. They cover channel classification, the default
 * channel policy, candidate selection, prerelease-channel rules (a beta range
 * is never assumed to include an RC), cooldown, excluded versions, and the
 * candidate's reference-pack status.
 *
 * @since 0.0.0
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Freshness from "../src/Freshness.ts"
import { makePackageIdentity } from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"
import * as Resolver from "../src/Resolver.ts"

const trackedDirs: Array<string> = []
const track = (dir: string): string => {
  trackedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true })
  trackedDirs.length = 0
})

const NOW = new Date("2026-08-15T00:00:00.000Z")

const resolution = (args: {
  expectedVersion: string
  installedVersion?: string
  source?: "lockfile" | "package.json"
}): Resolver.Resolution =>
  Resolver.makeResolution({
    expected: makePackageIdentity({
      name: "effect",
      version: args.expectedVersion,
      source: args.source ?? "lockfile"
    }),
    installed: args.installedVersion === undefined
      ? null
      : makePackageIdentity({
        name: "effect",
        version: args.installedVersion,
        source: "installed"
      }),
    lockfile: "pnpm-lock",
    status: "resolved"
  })

const snapshot = (versions: Array<[string, string]>): Freshness.RegistrySnapshot =>
  Freshness.makeRegistrySnapshot({
    name: "effect",
    distTags: { rc: "4.0.0-rc.109" },
    versions: versions.map(([version, publishedAt]) =>
      Freshness.makeRegistryVersion({ version, publishedAt })
    )
  })

const base = (args: {
  resolution: Resolver.Resolution
  registry: Freshness.RegistrySnapshot
  cacheDir: string
  now?: Date
  channelPolicy?: Freshness.ChannelPolicy
  cooldownPolicy?: Freshness.CooldownPolicy
  excludedVersions?: ReadonlyArray<string>
  catalog?: ReadonlyArray<ReferencePack.PackManifest> | null
}): Freshness.FreshnessRecommendation =>
  Freshness.computeFreshnessRecommendation({
    project: "/abs/project",
    cacheDir: args.cacheDir,
    resolution: args.resolution,
    registry: args.registry,
    now: args.now ?? NOW,
    catalog: args.catalog ?? null,
    ...(args.channelPolicy === undefined ? {} : { channelPolicy: args.channelPolicy }),
    ...(args.cooldownPolicy === undefined ? {} : { cooldownPolicy: args.cooldownPolicy }),
    ...(args.excludedVersions === undefined ? {} : { excludedVersions: args.excludedVersions })
  })

const tempCache = (): string => track(mkdtempSync(join(tmpdir(), "el-fresh-cache-")))

const upstream = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "deadbeef"
})

const packEntry = (version: string, id: string): ReferencePack.PackManifest =>
  ReferencePack.makePackManifest({
    id,
    effectVersion: version,
    packageIdentity: makePackageIdentity({ name: "effect", version, source: "lockfile" }),
    upstream,
    includedPaths: ["LLMS.md"],
    status: "complete"
  })

describe("channel classification", () => {
  it("classifies exact versions by prerelease channel", () => {
    expect(Freshness.channelOf("4.0.0-beta.83")).toBe("beta")
    expect(Freshness.channelOf("4.0.0-rc.109")).toBe("rc")
    expect(Freshness.channelOf("4.0.0")).toBe("stable")
    expect(Freshness.channelOf("4.0.0-alpha.1")).toBe("alpha")
    expect(Freshness.channelOf("4.0.0-custom.1")).toBe("other")
  })

  it("classifies declared specifiers, including ranges", () => {
    expect(Freshness.channelOfSpecifier("4.0.0-beta.83")).toBe("beta")
    expect(Freshness.channelOfSpecifier("^4.0.0")).toBe("stable")
    expect(Freshness.channelOfSpecifier("^4.0.0-rc.109")).toBe("rc")
  })
})

describe("default channel policy", () => {
  it("allows moving to any channel at or after the declared channel", () => {
    expect(Freshness.defaultChannelPolicy.allowedTargets("beta")).toEqual([
      "beta",
      "rc",
      "stable"
    ])
    expect(Freshness.defaultChannelPolicy.allowedTargets("rc")).toEqual(["rc", "stable"])
    expect(Freshness.defaultChannelPolicy.allowedTargets("stable")).toEqual(["stable"])
  })
})

describe("computeFreshnessRecommendation", () => {
  it("recommends the current allowed RC to a beta.83 project when policy permits", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir
    })
    expect(rec.status).toBe("recommendation")
    expect(Option.getOrNull(rec.candidate)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(rec.channel)).toBe("beta")
    expect(Option.getOrNull(rec.installed)?.version).toBe("4.0.0-beta.83")
    expect(Option.getOrNull(rec.cooldown)?.allowed).toBe(true)
    // A valid publish timestamp still reports its age even with no cooldown.
    const cooldown = Option.getOrNull(rec.cooldown)
    expect(cooldown !== null && Option.getOrNull(cooldown.ageDays)).toBeTypeOf("number")
  })

  it("does NOT recommend an RC to a beta project under a same-channel-only policy", () => {
    const cacheDir = tempCache()
    const strict: Freshness.ChannelPolicy = {
      allowedTargets: (declared) => [declared]
    }
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir,
      channelPolicy: strict
    })
    // The beta range does not automatically include the RC.
    expect(rec.status).toBe("up-to-date")
    expect(Option.getOrNull(rec.candidate)).toBeNull()
  })

  it("reports cooldown when the candidate is too new", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        // Published 1 day before NOW (2026-08-15).
        ["4.0.0-rc.109", "2026-08-14T00:00:00.000Z"]
      ]),
      cacheDir,
      cooldownPolicy: { minAgeDays: 7 }
    })
    expect(rec.status).toBe("cooldown")
    expect(Option.getOrNull(rec.candidate)?.version).toBe("4.0.0-rc.109")
    expect(Option.getOrNull(rec.cooldown)?.allowed).toBe(false)
    expect(Option.getOrNull(rec.cooldown)?.minAgeDays).toBe(7)
  })

  it("recommends a candidate that passes the cooldown", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        // Published 10 days before NOW.
        ["4.0.0-rc.109", "2026-08-05T00:00:00.000Z"]
      ]),
      cacheDir,
      cooldownPolicy: { minAgeDays: 7 }
    })
    expect(rec.status).toBe("recommendation")
    expect(Option.getOrNull(rec.cooldown)?.allowed).toBe(true)
  })

  it("honours per-channel cooldown overrides", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        // 1 day old; rc override is 0 so it passes.
        ["4.0.0-rc.109", "2026-08-14T00:00:00.000Z"]
      ]),
      cacheDir,
      cooldownPolicy: { minAgeDays: 7, perChannel: { rc: 0 } }
    })
    expect(rec.status).toBe("recommendation")
  })

  it("allows a candidate with no publish timestamp when no cooldown is configured", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: Freshness.makeRegistrySnapshot({
        name: "effect",
        versions: [
          Freshness.makeRegistryVersion({ version: "4.0.0-beta.83" }),
          Freshness.makeRegistryVersion({ version: "4.0.0-rc.109" })
        ]
      }),
      cacheDir
    })
    // Default cooldown is 0; a missing timestamp must not block a recommendation.
    expect(rec.status).toBe("recommendation")
    expect(Option.getOrNull(rec.cooldown)?.allowed).toBe(true)
  })

  it("fails closed when a positive cooldown cannot be verified", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: Freshness.makeRegistrySnapshot({
        name: "effect",
        versions: [
          Freshness.makeRegistryVersion({ version: "4.0.0-beta.83" }),
          Freshness.makeRegistryVersion({ version: "4.0.0-rc.109" })
        ]
      }),
      cacheDir,
      cooldownPolicy: { minAgeDays: 7 }
    })
    expect(rec.status).toBe("cooldown")
    expect(Option.getOrNull(rec.cooldown)?.allowed).toBe(false)
  })

  it("never selects an excluded version", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir,
      excludedVersions: ["4.0.0-rc.109"]
    })
    expect(rec.status).toBe("up-to-date")
    expect(rec.excluded).toContain("4.0.0-rc.109")
  })

  it("reports up-to-date when the installed version is the newest allowed", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-rc.109" }),
      registry: snapshot([["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]]),
      cacheDir
    })
    expect(rec.status).toBe("up-to-date")
    expect(Option.getOrNull(rec.candidate)).toBeNull()
  })

  it("reports unresolved when no exact installed version can be derived", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: Resolver.makeResolution({
        expected: makePackageIdentity({
          name: "effect",
          version: "^4.0.0",
          source: "package.json"
        }),
        installed: null,
        lockfile: "missing",
        status: "missing-lockfile"
      }),
      registry: snapshot([["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]]),
      cacheDir
    })
    expect(rec.status).toBe("unresolved")
    expect(rec.diagnostics.some((d) => d.id === "freshness-unresolved")).toBe(true)
  })

  it("reports catalog-missing when no catalog entry provides the candidate", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir,
      catalog: [packEntry("4.0.0-beta.83", "pack-effect-beta83")]
    })
    expect(rec.status).toBe("recommendation")
    expect(Option.getOrNull(rec.packStatus)).toBe("catalog-missing")
    expect(rec.diagnostics.some((d) => d.id === "freshness-pack-missing")).toBe(true)
  })

  it("reports unknown pack status when no catalog is provided", () => {
    const cacheDir = tempCache()
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir
    })
    expect(Option.getOrNull(rec.packStatus)).toBe("unknown")
  })

  it("reports available when the candidate pack is cached and verified", () => {
    const cacheDir = tempCache()
    const entry = packEntry("4.0.0-rc.109", "pack-effect-109")
    const packDir = join(cacheDir, entry.id)
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, "LLMS.md"), "content")
    writeFileSync(
      join(packDir, "manifest.json"),
      JSON.stringify(Schema.encodeSync(ReferencePack.PackManifest)(entry))
    )
    const rec = base({
      resolution: resolution({ expectedVersion: "4.0.0-beta.83" }),
      registry: snapshot([
        ["4.0.0-beta.83", "2026-01-01T00:00:00.000Z"],
        ["4.0.0-rc.109", "2026-01-10T00:00:00.000Z"]
      ]),
      cacheDir,
      catalog: [entry]
    })
    expect(Option.getOrNull(rec.packStatus)).toBe("available")
    expect(Option.getOrNull(rec.packId)).toBe("pack-effect-109")
  })
})
