/**
 * Source provenance and attribution for Effect Lens reference material.
 *
 * The model distinguishes two notions of identity that must never be confused:
 * - `PackageIdentity` (see {@link ./PackageIdentity.ts}): the npm dependency
 *   identity taken from the project lockfile / `package.json` / installed
 *   package (name, version, integrity).
 * - `UpstreamRef`: the *source* identity of upstream Effect material
 *   (repository, ref, commit). Lockfile identity and upstream commit identity
 *   are intentionally separate types so a stale reference pack can never be
 *   reported as a matching installed package and vice versa.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Whether a piece of guidance or a rule originates from upstream Effect
 * practice, from Lens strict policy, or from Lens advisory design analysis.
 * The model MUST keep these distinct so Lens strict-policy rules are never
 * presented as unqualified upstream authority, and so advisory design
 * recommendations (e.g. `@typeonce/effect-machine`) are never presented as
 * strict rules or as upstream Effect guidance. A first-party project rule
 * provider (e.g. StyleX) that has no Lens or upstream Effect equivalent is
 * classified as `project` so it is never mislabeled as upstream Effect
 * guidance or Lens strict policy.
 *
 * @since 0.0.0
 */
export const SourceKind = Schema.Literals(["upstream", "lens-strict", "lens-advisory", "project"])
export type SourceKind = Schema.Schema.Type<typeof SourceKind>

/**
 * Identity of upstream source material: the repository plus an optional
 * ref/tag and an optional commit SHA. This is source identity, not the
 * installed-package identity.
 *
 * @since 0.0.0
 */
export class UpstreamRef extends Schema.Class<UpstreamRef>("UpstreamRef")({
  repository: Schema.NonEmptyString,
  ref: Schema.OptionFromNullOr(Schema.NonEmptyString),
  commit: Schema.OptionFromNullOr(Schema.NonEmptyString),
  sourceUrl: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * Licensing and attribution metadata required when Lens manages or reproduces
 * upstream Effect or effect-solutions material.
 *
 * @since 0.0.0
 */
export class Attribution extends Schema.Class<Attribution>("Attribution")({
  license: Schema.OptionFromNullOr(Schema.NonEmptyString),
  copyright: Schema.OptionFromNullOr(Schema.NonEmptyString),
  notice: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * A single piece of evidence backing a guidance item or rule finding. Every
 * finding carries evidence so recommendations are always traceable to a source
 * and, where available, a version/commit.
 *
 * @since 0.0.0
 */
export class Evidence extends Schema.Class<Evidence>("Evidence")({
  source: Schema.NonEmptyString,
  ref: Schema.OptionFromNullOr(Schema.NonEmptyString),
  location: Schema.OptionFromNullOr(Schema.NonEmptyString),
  snippet: Schema.OptionFromNullOr(Schema.String),
  attribution: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * Constructs an {@link Evidence} value with sensible `null` defaults for the
 * optional fields.
 *
 * @since 0.0.0
 */
export const makeEvidence = (args: {
  source: string
  ref?: string | null
  location?: string | null
  snippet?: string | null
  attribution?: string | null
}): Evidence =>
  new Evidence({
    source: args.source,
    ref: Option.fromNullishOr(args.ref),
    location: Option.fromNullishOr(args.location),
    snippet: Option.fromNullishOr(args.snippet),
    attribution: Option.fromNullishOr(args.attribution)
  })

/**
 * Constructs an {@link UpstreamRef} value.
 *
 * @since 0.0.0
 */
export const makeUpstreamRef = (args: {
  repository: string
  ref?: string | null
  commit?: string | null
  sourceUrl?: string | null
}): UpstreamRef =>
  new UpstreamRef({
    repository: args.repository,
    ref: Option.fromNullishOr(args.ref),
    commit: Option.fromNullishOr(args.commit),
    sourceUrl: Option.fromNullishOr(args.sourceUrl)
  })
