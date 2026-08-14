/**
 * Lens-managed, versioned reference packs of selected upstream Effect and
 * effect-solutions material.
 *
 * A pack manifest preserves package identity, upstream commit identity,
 * included paths, source URL, integrity, and licensing/attribution. Packs are
 * cached by immutable identity and may coexist for multiple Effect versions.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PackageIdentity } from "./PackageIdentity.ts"
import { Attribution, UpstreamRef } from "./Provenance.ts"

/**
 * The health of a reference pack relative to what the current project expects.
 *
 * @since 0.0.0
 */
export const PackStatus = Schema.Literals(["missing", "partial", "complete", "stale"])
export type PackStatus = Schema.Schema.Type<typeof PackStatus>

/**
 * @since 0.0.0
 */
export class PackManifest extends Schema.Class<PackManifest>("PackManifest")({
  id: Schema.NonEmptyString,
  effectVersion: Schema.NonEmptyString,
  packageIdentity: PackageIdentity,
  upstream: UpstreamRef,
  includedPaths: Schema.Array(Schema.NonEmptyString),
  sourceUrl: Schema.OptionFromNullOr(Schema.NonEmptyString),
  integrity: Schema.OptionFromNullOr(Schema.NonEmptyString),
  attribution: Schema.OptionFromNullOr(Attribution),
  status: PackStatus
}) {}

/**
 * Result of verifying a {@link PackManifest} against the on-disk cache.
 *
 * @since 0.0.0
 */
export class PackVerification extends Schema.Class<PackVerification>("PackVerification")({
  manifest: PackManifest,
  missingFiles: Schema.Array(Schema.NonEmptyString),
  metadataChanged: Schema.Boolean,
  stale: Schema.Boolean,
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link PackManifest} value.
 *
 * @since 0.0.0
 */
export const makePackManifest = (args: {
  id: string
  effectVersion: string
  packageIdentity: PackageIdentity
  upstream: UpstreamRef
  includedPaths: Array<string>
  status: PackStatus
  sourceUrl?: string | null
  integrity?: string | null
  attribution?: Attribution | null
}): PackManifest =>
  new PackManifest({
    id: args.id,
    effectVersion: args.effectVersion,
    packageIdentity: args.packageIdentity,
    upstream: args.upstream,
    includedPaths: args.includedPaths,
    sourceUrl: Option.fromNullishOr(args.sourceUrl),
    integrity: Option.fromNullishOr(args.integrity),
    attribution: Option.fromNullishOr(args.attribution),
    status: args.status
  })

export { Attribution }
export type { PackageIdentity } from "./PackageIdentity.ts"
export type { UpstreamRef } from "./Provenance.ts"
