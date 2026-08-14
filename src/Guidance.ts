/**
 * Version-aware guidance records normalized from upstream Effect and
 * effect-solutions material.
 *
 * Every guidance item preserves its source kind, its version applicability,
 * its upstream ref, its validation status, and its evidence. Contradictory
 * sources MUST produce a `conflict` validation status rather than being
 * silently merged.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Evidence, makeEvidence, SourceKind, UpstreamRef } from "./Provenance.ts"

/**
 * A semver applicability window. `from` is inclusive; `to`, when present, is
 * exclusive.
 *
 * @since 0.0.0
 */
export class GuidanceAppliesTo extends Schema.Class<GuidanceAppliesTo>("GuidanceAppliesTo")({
  from: Schema.NonEmptyString,
  to: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * How far guidance has been validated against source/examples.
 *
 * @since 0.0.0
 */
export const GuidanceValidationStatus = Schema.Literals(["validated", "unvalidated", "conflict"])
export type GuidanceValidationStatus = Schema.Schema.Type<typeof GuidanceValidationStatus>

/**
 * A single normalized guidance item.
 *
 * @since 0.0.0
 */
export class Guidance extends Schema.Class<Guidance>("Guidance")({
  id: Schema.NonEmptyString,
  topic: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
  source: SourceKind,
  appliesTo: Schema.OptionFromNullOr(GuidanceAppliesTo),
  upstreamRef: Schema.OptionFromNullOr(UpstreamRef),
  validationStatus: GuidanceValidationStatus,
  evidence: Schema.Array(Evidence)
}) {}

/**
 * Constructs a {@link Guidance} value.
 *
 * @since 0.0.0
 */
export const makeGuidance = (args: {
  id: string
  topic: string
  summary: string
  source: Schema.Schema.Type<typeof SourceKind>
  validationStatus: GuidanceValidationStatus
  evidence: Array<Evidence>
  appliesTo?: GuidanceAppliesTo | null
  upstreamRef?: UpstreamRef | null
}): Guidance =>
  new Guidance({
    id: args.id,
    topic: args.topic,
    summary: args.summary,
    source: args.source,
    appliesTo: Option.fromNullishOr(args.appliesTo),
    upstreamRef: Option.fromNullishOr(args.upstreamRef),
    validationStatus: args.validationStatus,
    evidence: args.evidence
  })

/**
 * Constructs a {@link GuidanceAppliesTo} value.
 *
 * @since 0.0.0
 */
export const makeAppliesTo = (args: {
  from: string
  to?: string | null
}): GuidanceAppliesTo =>
  new GuidanceAppliesTo({ from: args.from, to: Option.fromNullishOr(args.to) })

export { makeEvidence, SourceKind }
export type { Evidence } from "./Provenance.ts"
