/**
 * Read-only freshness recommendation for a project's Effect dependency
 * (issue #15).
 *
 * This module answers: "given the project's installed/declared Effect version
 * and an explicit registry snapshot, what is the newest Effect release allowed
 * by the channel and release-age/cooldown policy, and does a reference pack
 * exist for it?" It is the network-backed counterpart to the offline
 * `drift`/`packs status` slices: it consumes an explicit, injectable registry
 * snapshot and never performs network I/O itself.
 *
 * The recommendation is strictly read-only and advisory. It NEVER mutates
 * package manifests, lockfiles, or pack caches, and it never selects a
 * reference pack implicitly — a missing candidate pack is reported as an
 * actionable `catalog-missing` / `not-cached` result, not fetched. Dependency
 * mutation is left to Nub; this module only advises.
 *
 * The policy is explicit and testable:
 * - Channel policy decides which prerelease channels a project may move to.
 *   The default is the "more mature" rule: a project may move to any channel
 *   at or after its declared channel in `alpha < beta < rc < stable` order.
 *   A beta project MAY be recommended an RC, but only because the policy
 *   explicitly permits it — a beta range is never assumed to include an RC.
 * - Cooldown policy applies a minimum release age (in days) before a
 *   candidate is recommended, with optional per-channel overrides.
 * - Excluded versions are never selected as candidates.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "./Finding.ts"
import { makePackageIdentity, PackageIdentity } from "./PackageIdentity.ts"
import * as PackPlan from "./PackPlan.ts"
import * as PackVerifier from "./PackVerifier.ts"
import { PackManifest } from "./ReferencePack.ts"
import * as Resolver from "./Resolver.ts"
import { compareVersions } from "./Version.ts"

/**
 * The prerelease maturity channel of an Effect version. `stable` is a release
 * with no prerelease; `other` is a prerelease whose first identifier is not a
 * known channel (e.g. `alpha` is known, a custom tag is `other`).
 *
 * @since 0.0.0
 */
export const Channel = Schema.Literals(["alpha", "beta", "rc", "stable", "other"])
export type Channel = Schema.Schema.Type<typeof Channel>

/**
 * The maturity order used by the default channel policy. A project may move to
 * any channel at or after its declared channel in this order.
 *
 * @since 0.0.0
 */
export const CHANNEL_ORDER: ReadonlyArray<Channel> = ["alpha", "beta", "rc", "stable"]

/**
 * Determines the {@link Channel} of an exact version string. A version with no
 * prerelease is `stable`; otherwise the first prerelease identifier (lowercased)
 * names the channel, with unknown identifiers reported as `other`.
 *
 * @since 0.0.0
 */
export const channelOf = (version: string): Channel => {
  const pre = version.split("-")[1]
  if (pre === undefined) return "stable"
  const id = pre.split(".")[0].toLowerCase()
  if (id === "alpha") return "alpha"
  if (id === "beta") return "beta"
  if (id === "rc") return "rc"
  return "other"
}

/**
 * Determines the {@link Channel} of a declared specifier, which may be an exact
 * version or a range (e.g. `^4.0.0`). The channel is taken from the first
 * version-like token in the specifier; a range with no prerelease is `stable`.
 *
 * @since 0.0.0
 */
export const channelOfSpecifier = (specifier: string): Channel => {
  const match = specifier.match(/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/)
  if (match === null) return "stable"
  return channelOf(match[0])
}

/**
 * The channel policy: given a project's declared channel, the set of channels
 * it may move to. Injectable so tests can exercise a stricter rule (e.g. "same
 * channel only", which must NOT recommend an RC to a beta project).
 *
 * @since 0.0.0
 */
export interface ChannelPolicy {
  readonly allowedTargets: (declared: Channel) => ReadonlyArray<Channel>
}

/**
 * The default channel policy: a project may move to any channel at or after its
 * declared channel in `alpha < beta < rc < stable` order. An unknown channel
 * (`other`) may only move within itself.
 *
 * @since 0.0.0
 */
export const defaultChannelPolicy: ChannelPolicy = {
  allowedTargets(declared) {
    const idx = CHANNEL_ORDER.indexOf(declared)
    if (idx === -1) return [declared]
    return CHANNEL_ORDER.slice(idx)
  }
}

/**
 * The release-age/cooldown policy. `minAgeDays` is the minimum age (in days) a
 * candidate must have before it is recommended; `perChannel` optionally
 * overrides it for a specific channel.
 *
 * @since 0.0.0
 */
export interface CooldownPolicy {
  readonly minAgeDays: number
  readonly perChannel?: Partial<Record<Channel, number>>
}

/**
 * The default cooldown policy: no cooldown. Projects opt into a cooldown via
 * `--cooldown-days` or an injected policy.
 *
 * @since 0.0.0
 */
export const defaultCooldownPolicy: CooldownPolicy = { minAgeDays: 0 }

/**
 * The minimum age (in days) a candidate must have under a {@link CooldownPolicy}
 * for a given channel, honouring per-channel overrides.
 *
 * @since 0.0.0
 */
export const cooldownDaysFor = (policy: CooldownPolicy, channel: Channel): number =>
  policy.perChannel?.[channel] ?? policy.minAgeDays

/**
 * A single version observed in a registry snapshot, with its publish timestamp
 * (when the registry reports one).
 *
 * @since 0.0.0
 */
export class RegistryVersion extends Schema.Class<RegistryVersion>("RegistryVersion")({
  version: Schema.NonEmptyString,
  publishedAt: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * Constructs a {@link RegistryVersion} value.
 *
 * @since 0.0.0
 */
export const makeRegistryVersion = (args: {
  version: string
  publishedAt?: string | null
}): RegistryVersion =>
  new RegistryVersion({
    version: args.version,
    publishedAt: Option.fromNullishOr(args.publishedAt)
  })

/**
 * An explicit, injectable snapshot of a package's registry state: the dist-tags
 * (informational) and every version with its publish timestamp. This is the
 * ONLY place the recommendation learns about available versions; it never
 * invents a version or consults a remote itself.
 *
 * @since 0.0.0
 */
export class RegistrySnapshot extends Schema.Class<RegistrySnapshot>("RegistrySnapshot")({
  name: Schema.NonEmptyString,
  distTags: Schema.Record(Schema.String, Schema.String),
  versions: Schema.Array(RegistryVersion)
}) {}

/**
 * Constructs a {@link RegistrySnapshot} value.
 *
 * @since 0.0.0
 */
export const makeRegistrySnapshot = (args: {
  name: string
  distTags?: Record<string, string>
  versions: Array<RegistryVersion>
}): RegistrySnapshot =>
  new RegistrySnapshot({
    name: args.name,
    distTags: args.distTags ?? {},
    versions: args.versions
  })

/**
 * The result of applying the cooldown policy to a candidate.
 *
 * @since 0.0.0
 */
export class CooldownResult extends Schema.Class<CooldownResult>("CooldownResult")({
  allowed: Schema.Boolean,
  minAgeDays: Schema.Number,
  ageDays: Schema.OptionFromNullOr(Schema.Number),
  publishedAt: Schema.OptionFromNullOr(Schema.NonEmptyString),
  reason: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link CooldownResult} value.
 *
 * @since 0.0.0
 */
export const makeCooldownResult = (args: {
  allowed: boolean
  minAgeDays: number
  ageDays?: number | null
  publishedAt?: string | null
  reason?: string | null
}): CooldownResult =>
  new CooldownResult({
    allowed: args.allowed,
    minAgeDays: args.minAgeDays,
    ageDays: Option.fromNullishOr(args.ageDays),
    publishedAt: Option.fromNullishOr(args.publishedAt),
    reason: Option.fromNullishOr(args.reason)
  })

/**
 * The reference-pack availability for a recommended candidate.
 *
 * - `available` — a catalog entry exists for the candidate and its pack is
 *   cached and verified.
 * - `not-cached` — a catalog entry exists but the pack is not cached/verified.
 * - `catalog-missing` — no catalog entry provides the candidate version.
 * - `unknown` — no catalog was provided, so availability cannot be determined.
 *
 * @since 0.0.0
 */
export const CandidatePackStatus = Schema.Literals([
  "available",
  "not-cached",
  "catalog-missing",
  "unknown"
])
export type CandidatePackStatus = Schema.Schema.Type<typeof CandidatePackStatus>

/**
 * The aggregate outcome of a freshness recommendation.
 *
 * - `unresolved` — no exact installed Effect version could be derived.
 * - `network-error` — the registry snapshot could not be fetched.
 * - `up-to-date` — the installed version is the newest allowed candidate.
 * - `recommendation` — a newer allowed candidate exists and passes cooldown.
 * - `cooldown` — a newer allowed candidate exists but fails the cooldown.
 * - `no-candidate` — no newer allowed candidate could be selected.
 *
 * @since 0.0.0
 */
export const FreshnessStatus = Schema.Literals([
  "unresolved",
  "network-error",
  "up-to-date",
  "recommendation",
  "cooldown",
  "no-candidate"
])
export type FreshnessStatus = Schema.Schema.Type<typeof FreshnessStatus>

/**
 * A complete, Schema-backed read-only freshness recommendation.
 *
 * `resolution` is the resolver outcome; `installed` the exact installed
 * version; `declaredSpecifier` the raw declared specifier; `channel` the
 * declared channel. `candidate` is the newest allowed candidate (or `null`),
 * with `candidatePublishedAt`, `cooldown`, `packStatus`, and `packId` describing
 * it. `excluded` lists the versions excluded by policy. `status` is the
 * aggregate outcome; `diagnostics` drive exit policy and `message` is a
 * human-readable summary.
 *
 * @since 0.0.0
 */
export class FreshnessRecommendation extends Schema.Class<FreshnessRecommendation>(
  "FreshnessRecommendation"
)({
  project: Schema.NonEmptyString,
  cacheDir: Schema.NonEmptyString,
  workspace: Schema.OptionFromNullOr(Schema.NonEmptyString),
  resolution: Resolver.Resolution,
  installed: Schema.OptionFromNullOr(PackageIdentity),
  declaredSpecifier: Schema.OptionFromNullOr(Schema.NonEmptyString),
  channel: Schema.OptionFromNullOr(Channel),
  candidate: Schema.OptionFromNullOr(PackageIdentity),
  candidatePublishedAt: Schema.OptionFromNullOr(Schema.NonEmptyString),
  cooldown: Schema.OptionFromNullOr(CooldownResult),
  packStatus: Schema.OptionFromNullOr(CandidatePackStatus),
  packId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  excluded: Schema.Array(Schema.NonEmptyString),
  status: FreshnessStatus,
  diagnostics: Schema.Array(Diagnostic),
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link FreshnessRecommendation} value.
 *
 * @since 0.0.0
 */
export const makeFreshnessRecommendation = (args: {
  project: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  installed?: PackageIdentity | null
  declaredSpecifier?: string | null
  channel?: Channel | null
  candidate?: PackageIdentity | null
  candidatePublishedAt?: string | null
  cooldown?: CooldownResult | null
  packStatus?: CandidatePackStatus | null
  packId?: string | null
  excluded?: Array<string>
  status: FreshnessStatus
  diagnostics?: Array<Diagnostic>
  message?: string | null
}): FreshnessRecommendation =>
  new FreshnessRecommendation({
    project: args.project,
    cacheDir: args.cacheDir,
    workspace: Option.fromNullishOr(args.workspace),
    resolution: args.resolution,
    installed: Option.fromNullishOr(args.installed),
    declaredSpecifier: Option.fromNullishOr(args.declaredSpecifier),
    channel: Option.fromNullishOr(args.channel),
    candidate: Option.fromNullishOr(args.candidate),
    candidatePublishedAt: Option.fromNullishOr(args.candidatePublishedAt),
    cooldown: Option.fromNullishOr(args.cooldown),
    packStatus: Option.fromNullishOr(args.packStatus),
    packId: Option.fromNullishOr(args.packId),
    excluded: args.excluded ?? [],
    status: args.status,
    diagnostics: args.diagnostics ?? [],
    message: Option.fromNullishOr(args.message)
  })

const diag = (
  id: string,
  severity: "warning" | "error" | "off",
  message: string
): Diagnostic => new Diagnostic({ id, severity, message, location: Option.none() })

/**
 * The exact installed Effect version for a resolution: the installed package
 * when present, else the expected identity when it is an exact version, else
 * `null` (a range specifier with no installed package cannot anchor a
 * recommendation).
 *
 * @since 0.0.0
 */
const installedIdentityOf = (resolution: Resolver.Resolution): PackageIdentity | null => {
  const installed = Option.getOrNull(resolution.installed)
  if (installed !== null) return installed
  const expected = Option.getOrNull(resolution.expected)
  if (expected !== null && PackPlan.isExactVersion(expected.version)) return expected
  return null
}

/**
 * Computes the {@link CooldownResult} for a candidate under a policy.
 *
 * @since 0.0.0
 */
export const computeCooldown = (args: {
  policy: CooldownPolicy
  channel: Channel
  publishedAt: string | null
  now: Date
}): CooldownResult => {
  const minAgeDays = cooldownDaysFor(args.policy, args.channel)
  // Parse the publish timestamp when present. A missing/invalid timestamp is
  // only a problem when a positive cooldown must be verified.
  let published: Date | null = null
  if (args.publishedAt !== null) {
    const parsed = new Date(args.publishedAt)
    if (!Number.isNaN(parsed.getTime())) published = parsed
  }
  // No cooldown configured: a missing/invalid timestamp cannot block a
  // recommendation, but a valid one still reports its age.
  if (minAgeDays <= 0) {
    return makeCooldownResult({
      allowed: true,
      minAgeDays,
      ageDays: published === null
        ? null
        : (args.now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24),
      publishedAt: args.publishedAt,
      reason: published === null
        ? "no cooldown configured; publish timestamp not required"
        : `no cooldown configured (min ${minAgeDays} days)`
    })
  }
  if (published === null) {
    return makeCooldownResult({
      allowed: false,
      minAgeDays,
      publishedAt: args.publishedAt,
      reason: args.publishedAt === null
        ? "candidate has no publish timestamp; cooldown cannot be verified"
        : "candidate publish timestamp is invalid"
    })
  }
  const ageDays = (args.now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24)
  const allowed = ageDays >= minAgeDays
  return makeCooldownResult({
    allowed,
    minAgeDays,
    ageDays,
    publishedAt: args.publishedAt,
    reason: allowed
      ? `candidate is ${ageDays.toFixed(1)} days old (min ${minAgeDays})`
      : `candidate is ${ageDays.toFixed(1)} days old (min ${minAgeDays}); cooldown not met`
  })
}

/**
 * Computes the reference-pack availability for a candidate version against an
 * explicit catalog and the on-disk cache. Read-only: it never fetches or
 * mutates anything. With no catalog the status is `unknown`.
 *
 * @since 0.0.0
 */
export const candidatePackStatus = (args: {
  catalog: ReadonlyArray<PackManifest> | null
  candidateVersion: string
  cacheDir: string
}): { status: CandidatePackStatus; packId: string | null } => {
  if (args.catalog === null) return { status: "unknown", packId: null }
  const entry = args.catalog.find(
    (e) =>
      e.packageIdentity.name === "effect" && e.packageIdentity.version === args.candidateVersion
  )
  if (entry === undefined) return { status: "catalog-missing", packId: null }
  const verification = PackVerifier.verifyPack({
    manifest: entry,
    expected: entry.packageIdentity,
    cacheDir: args.cacheDir
  })
  const ok = verification.missingFiles.length === 0 && !verification.metadataChanged
  return { status: ok ? "available" : "not-cached", packId: entry.id }
}

/**
 * Builds an `unresolved` recommendation: no exact installed version could be
 * derived, so no candidate can be selected.
 *
 * @since 0.0.0
 */
const unresolved = (args: {
  project: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  declaredSpecifier: string | null
  detail: string
}): FreshnessRecommendation =>
  makeFreshnessRecommendation({
    project: args.project,
    cacheDir: args.cacheDir,
    workspace: args.workspace,
    resolution: args.resolution,
    declaredSpecifier: args.declaredSpecifier,
    status: "unresolved",
    diagnostics: [diag("freshness-unresolved", "error", args.detail)],
    message: `cannot advise on Effect freshness: ${args.detail}`
  })

/**
 * Builds a `network-error` recommendation: the registry snapshot could not be
 * fetched, so no candidate can be evaluated.
 *
 * @since 0.0.0
 */
export const networkErrorRecommendation = (args: {
  project: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  detail: string
}): FreshnessRecommendation => {
  const expected = Option.getOrNull(args.resolution.expected)
  const declaredSpecifier = expected?.version ?? null
  const installed = installedIdentityOf(args.resolution)
  const channel = declaredSpecifier !== null
    ? channelOfSpecifier(declaredSpecifier)
    : (installed !== null ? channelOf(installed.version) : null)
  return makeFreshnessRecommendation({
    project: args.project,
    cacheDir: args.cacheDir,
    workspace: args.workspace,
    resolution: args.resolution,
    installed,
    declaredSpecifier,
    channel,
    status: "network-error",
    diagnostics: [diag("freshness-network-error", "warning", args.detail)],
    message: `cannot advise on Effect freshness: ${args.detail}`
  })
}

/**
 * Computes a read-only freshness recommendation for a project from an explicit
 * registry snapshot and the channel/cooldown policy.
 *
 * It resolves the exact installed version and declared channel, selects the
 * newest allowed candidate (channel policy, excluded versions, newer than
 * installed), applies the cooldown policy, and reports the candidate's
 * reference-pack availability. It performs only read-only filesystem reads
 * (resolver/verifier); it never fetches, writes, deletes, or updates anything.
 *
 * Decision rules (documented):
 * 1. No exact installed version -> `unresolved`.
 * 2. No newer allowed candidate: installed is the newest allowed version ->
 *    `up-to-date`; otherwise -> `no-candidate`.
 * 3. A newer allowed candidate exists: cooldown passes -> `recommendation`;
 *    cooldown fails -> `cooldown`.
 *
 * @since 0.0.0
 */
export const computeFreshnessRecommendation = (args: {
  project: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  registry: RegistrySnapshot
  channelPolicy?: ChannelPolicy
  cooldownPolicy?: CooldownPolicy
  excludedVersions?: ReadonlyArray<string>
  now?: Date
  catalog?: ReadonlyArray<PackManifest> | null
}): FreshnessRecommendation => {
  const channelPolicy = args.channelPolicy ?? defaultChannelPolicy
  const cooldownPolicy = args.cooldownPolicy ?? defaultCooldownPolicy
  const excluded = [...(args.excludedVersions ?? [])]
  const now = args.now ?? new Date()

  const expected = Option.getOrNull(args.resolution.expected)
  const declaredSpecifier = expected?.version ?? null
  const installed = installedIdentityOf(args.resolution)

  // 1. No exact installed version.
  if (installed === null) {
    return unresolved({
      project: args.project,
      cacheDir: args.cacheDir,
      workspace: args.workspace,
      resolution: args.resolution,
      declaredSpecifier,
      detail: Option.getOrNull(args.resolution.detail) ??
        "no exact installed effect version could be derived"
    })
  }

  const channel = declaredSpecifier !== null
    ? channelOfSpecifier(declaredSpecifier)
    : channelOf(installed.version)
  const allowed = channelPolicy.allowedTargets(channel)

  const allowedVersions = args.registry.versions.filter(
    (v) => allowed.includes(channelOf(v.version)) && !excluded.includes(v.version)
  )
  const newer = allowedVersions.filter((v) => compareVersions(v.version, installed.version) > 0)
  const candidate = newer.length === 0
    ? null
    : newer.reduce((a, b) => (compareVersions(a.version, b.version) > 0 ? a : b))

  // 2. No newer allowed candidate.
  if (candidate === null) {
    const maxAllowed = allowedVersions.reduce<RegistryVersion | null>(
      (a, b) => (a === null || compareVersions(b.version, a.version) > 0 ? b : a),
      null
    )
    const upToDate = maxAllowed !== null &&
      compareVersions(installed.version, maxAllowed.version) >= 0
    if (upToDate) {
      return makeFreshnessRecommendation({
        project: args.project,
        cacheDir: args.cacheDir,
        workspace: args.workspace,
        resolution: args.resolution,
        installed,
        declaredSpecifier,
        channel,
        excluded,
        status: "up-to-date",
        message: `effect ${installed.version} is the newest allowed version`
      })
    }
    return makeFreshnessRecommendation({
      project: args.project,
      cacheDir: args.cacheDir,
      workspace: args.workspace,
      resolution: args.resolution,
      installed,
      declaredSpecifier,
      channel,
      excluded,
      status: "no-candidate",
      diagnostics: [
        diag(
          "freshness-no-candidate",
          "off",
          "no newer effect version is allowed by the channel policy"
        )
      ],
      message: "no newer effect version is allowed by the channel policy"
    })
  }

  // 3. A newer allowed candidate exists.
  const candidateChannel = channelOf(candidate.version)
  const cooldown = computeCooldown({
    policy: cooldownPolicy,
    channel: candidateChannel,
    publishedAt: Option.getOrNull(candidate.publishedAt),
    now
  })
  const pack = candidatePackStatus({
    catalog: args.catalog ?? null,
    candidateVersion: candidate.version,
    cacheDir: args.cacheDir
  })
  const candidateIdentity = makePackageIdentity({
    name: "effect",
    version: candidate.version,
    source: "registry"
  })

  if (cooldown.allowed) {
    const diagnostics: Array<Diagnostic> = [
      diag(
        "freshness-recommendation",
        "warning",
        `newer effect version ${candidate.version} is available and passes the cooldown`
      )
    ]
    if (pack.status === "catalog-missing" || pack.status === "not-cached") {
      diagnostics.push(
        diag(
          "freshness-pack-missing",
          "warning",
          `no verified reference pack is available for effect ${candidate.version}`
        )
      )
    }
    return makeFreshnessRecommendation({
      project: args.project,
      cacheDir: args.cacheDir,
      workspace: args.workspace,
      resolution: args.resolution,
      installed,
      declaredSpecifier,
      channel,
      candidate: candidateIdentity,
      candidatePublishedAt: Option.getOrNull(candidate.publishedAt),
      cooldown,
      packStatus: pack.status,
      packId: pack.packId,
      excluded,
      status: "recommendation",
      diagnostics,
      message: `recommend upgrading effect ${installed.version} to ${candidate.version}`
    })
  }
  return makeFreshnessRecommendation({
    project: args.project,
    cacheDir: args.cacheDir,
    workspace: args.workspace,
    resolution: args.resolution,
    installed,
    declaredSpecifier,
    channel,
    candidate: candidateIdentity,
    candidatePublishedAt: Option.getOrNull(candidate.publishedAt),
    cooldown,
    packStatus: pack.status,
    packId: pack.packId,
    excluded,
    status: "cooldown",
    diagnostics: [
      diag(
        "freshness-cooldown",
        "warning",
        `candidate ${candidate.version} is too new; ${
          Option.getOrNull(cooldown.reason) ?? "cooldown not met"
        }`
      )
    ],
    message: `candidate ${candidate.version} is available but fails the cooldown`
  })
}

export { PackManifest, PackVerifier, Resolver }
export type { PackageIdentity } from "./PackageIdentity.ts"
