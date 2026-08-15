/**
 * A single evidence-backed finding produced by a rule against a location.
 *
 * Every finding MUST identify its rule, severity, source kind, version
 * applicability, location, evidence, and the provider that produced it. This
 * is the shared result model that
 * CLI, pi, and future MCP adapters all consume — they MUST NOT define their own
 * finding shapes.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { GuidanceAppliesTo } from "./Guidance.ts"
import { Evidence, SourceKind } from "./Provenance.ts"
import { Severity } from "./Severity.ts"
import { Waiver } from "./Waiver.ts"

/**
 * Where a finding applies in a source file.
 *
 * @since 0.0.0
 */
export class FindingLocation extends Schema.Class<FindingLocation>("FindingLocation")({
  file: Schema.NonEmptyString,
  line: Schema.Number,
  column: Schema.OptionFromNullOr(Schema.Number),
  snippet: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * @since 0.0.0
 */
export class Finding extends Schema.Class<Finding>("Finding")({
  id: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  provider: Schema.OptionFromNullOr(Schema.NonEmptyString),
  severity: Severity,
  source: SourceKind,
  message: Schema.NonEmptyString,
  appliesTo: Schema.OptionFromNullOr(GuidanceAppliesTo),
  location: FindingLocation,
  evidence: Schema.Array(Evidence),
  waivers: Schema.Array(Waiver)
}) {}

/**
 * A non-rule diagnostic (e.g. a toolchain or resolution problem).
 *
 * @since 0.0.0
 */
export class Diagnostic extends Schema.Class<Diagnostic>("Diagnostic")({
  id: Schema.NonEmptyString,
  severity: Severity,
  message: Schema.NonEmptyString,
  location: Schema.OptionFromNullOr(FindingLocation)
}) {}

/**
 * Constructs a {@link Finding} value.
 *
 * @since 0.0.0
 */
export const makeFinding = (args: {
  id: string
  rule: string
  provider?: string
  severity: Schema.Schema.Type<typeof Severity>
  source: Schema.Schema.Type<typeof SourceKind>
  message: string
  location: FindingLocation
  evidence: Array<Evidence>
  appliesTo?: GuidanceAppliesTo | null
  waivers?: Array<Waiver>
}): Finding =>
  new Finding({
    id: args.id,
    rule: args.rule,
    provider: Option.fromNullishOr(args.provider ?? "lens"),
    severity: args.severity,
    source: args.source,
    message: args.message,
    appliesTo: Option.fromNullishOr(args.appliesTo),
    location: args.location,
    evidence: args.evidence,
    waivers: args.waivers ?? []
  })

/**
 * Constructs a {@link FindingLocation} value.
 *
 * @since 0.0.0
 */
export const makeLocation = (args: {
  file: string
  line: number
  column?: number | null
  snippet?: string | null
}): FindingLocation =>
  new FindingLocation({
    file: args.file,
    line: args.line,
    column: Option.fromNullishOr(args.column),
    snippet: Option.fromNullishOr(args.snippet)
  })
