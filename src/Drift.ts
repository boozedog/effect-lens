/**
 * Drift detection between the installed/declared Effect dependency, the
 * available reference pack, and upstream tooling.
 *
 * The report pairs the {@link ./PackageIdentity.ts package identity} (lockfile)
 * with the expected and actual {@link ./Provenance.ts upstream} identity so a
 * version mismatch is distinguishable from a commit/reference mismatch.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PackageIdentity } from "./PackageIdentity.ts"
import { UpstreamRef } from "./Provenance.ts"

/**
 * The relationship between declared, installed, and referenced material.
 *
 * @since 0.0.0
 */
export const DriftKind = Schema.Literals(["compatible", "stale", "missing", "conflict"])
export type DriftKind = Schema.Schema.Type<typeof DriftKind>

/**
 * What a drift entry observes: the declared/installed Effect dependency or the
 * available reference pack. Kept distinct so a dependency and a pack with the
 * same kind and package name are not conflated.
 *
 * @since 0.0.0
 */
export const DriftRole = Schema.Literals(["dependency", "pack"])
export type DriftRole = Schema.Schema.Type<typeof DriftRole>

/**
 * A single drift observation.
 *
 * @since 0.0.0
 */
export class DriftEntry extends Schema.Class<DriftEntry>("DriftEntry")({
  role: DriftRole,
  packageIdentity: PackageIdentity,
  expected: Schema.OptionFromNullOr(UpstreamRef),
  actual: Schema.OptionFromNullOr(UpstreamRef),
  kind: DriftKind,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The local toolchain used for analysis, for reproducibility.
 *
 * @since 0.0.0
 */
export class ToolchainManifest extends Schema.Class<ToolchainManifest>("ToolchainManifest")({
  lensVersion: Schema.NonEmptyString,
  effect: PackageIdentity,
  packageManager: Schema.OptionFromNullOr(Schema.NonEmptyString),
  node: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * A full drift report over a project.
 *
 * @since 0.0.0
 */
export class DriftReport extends Schema.Class<DriftReport>("DriftReport")({
  toolchain: ToolchainManifest,
  entries: Schema.Array(DriftEntry),
  generatedAt: Schema.DateTimeUtcFromString
}) {}

/**
 * Constructs a {@link DriftEntry} value.
 *
 * @since 0.0.0
 */
export const makeDriftEntry = (args: {
  role: DriftRole
  packageIdentity: PackageIdentity
  kind: DriftKind
  expected?: UpstreamRef | null
  actual?: UpstreamRef | null
  detail?: string | null
}): DriftEntry =>
  new DriftEntry({
    role: args.role,
    packageIdentity: args.packageIdentity,
    expected: Option.fromNullishOr(args.expected),
    actual: Option.fromNullishOr(args.actual),
    kind: args.kind,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * Constructs a {@link ToolchainManifest} value.
 *
 * @since 0.0.0
 */
export const makeToolchainManifest = (args: {
  lensVersion: string
  effect: PackageIdentity
  packageManager?: string | null
  node?: string | null
}): ToolchainManifest =>
  new ToolchainManifest({
    lensVersion: args.lensVersion,
    effect: args.effect,
    packageManager: Option.fromNullishOr(args.packageManager),
    node: Option.fromNullishOr(args.node)
  })

/**
 * Constructs a {@link DriftReport} value.
 *
 * @since 0.0.0
 */
export const makeDriftReport = (args: {
  toolchain: ToolchainManifest
  entries: Array<DriftEntry>
  generatedAt: Schema.Schema.Type<typeof Schema.DateTimeUtcFromString>
}): DriftReport => new DriftReport({ ...args })

export { UpstreamRef }
export type { PackageIdentity } from "./PackageIdentity.ts"
