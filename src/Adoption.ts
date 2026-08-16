/**
 * The read-only staged-adoption audit model for the `adoption audit` surface.
 *
 * An audit inspects a selected project/workspace and reports the target
 * identity, resolved Effect version, reference-pack status, detected oxlint
 * config and scopes, active Lens/Foldstryx/StyleX providers and rules,
 * equivalent-rule overlaps, current unified-gate findings, and actionable
 * migration recommendations. It is the first phase of the staged Foldstryx
 * adoption path (issue #14): it is strictly read-only and offline, never
 * mutates source, configs, packs, dependencies, or hooks, and never removes
 * Foldstryx rules or creates waivers. The model is Schema-backed and
 * JSON-serializable so CLI, pi, and future MCP adapters share one contract.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic, Finding } from "./Finding.ts"
import { PackVerificationResult } from "./PackVerifier.ts"
import { Resolution } from "./Resolver.ts"
import { OxlintStatus } from "./Setup.ts"

/**
 * The detected oxlint configuration scopes for a project.
 *
 * `configPath` is the config file name (`.oxlintrc.json`, `.oxlintrc`, or
 * `oxlint.json`) or `null` when none is present. `ignorePatterns` are the
 * configured `ignorePatterns` (empty when none). `overrides` are the
 * configured `overrides` blocks (empty when none). `rules` are the configured
 * rule settings keyed by rule id (empty when none). All are read verbatim
 * from the config and never rewritten.
 *
 * @since 0.0.0
 */
export class OxlintScopes extends Schema.Class<OxlintScopes>("OxlintScopes")({
  configPath: Schema.OptionFromNullOr(Schema.NonEmptyString),
  ignorePatterns: Schema.Array(Schema.String),
  overrides: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  rules: Schema.Record(Schema.String, Schema.Unknown)
}) {}

/**
 * Constructs an {@link OxlintScopes} value.
 *
 * @since 0.0.0
 */
export const makeOxlintScopes = (args: {
  configPath?: string | null
  ignorePatterns?: Array<string>
  overrides?: Array<Record<string, unknown>>
  rules?: Record<string, unknown>
}): OxlintScopes =>
  new OxlintScopes({
    configPath: Option.fromNullishOr(args.configPath),
    ignorePatterns: args.ignorePatterns ?? [],
    overrides: args.overrides ?? [],
    rules: args.rules ?? {}
  })

/**
 * The status of a single rule provider in the audit.
 *
 * `provider` is the stable provider identity (`lens`, `foldstryx`, or
 * `stylex`). `active` is true when the provider is loaded by the project's
 * oxlint config (a matching `jsPlugins` entry or a configured rule). `rules`
 * lists the provider's rule ids that are configured in the project's oxlint
 * config; for the Lens provider it always lists the catalog rule ids so the
 * audit shows the canonical rules available even when not configured.
 *
 * @since 0.0.0
 */
export class ProviderStatus extends Schema.Class<ProviderStatus>("ProviderStatus")({
  provider: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  active: Schema.Boolean,
  rules: Schema.Array(Schema.NonEmptyString)
}) {}

/**
 * Constructs a {@link ProviderStatus} value.
 *
 * @since 0.0.0
 */
export const makeProviderStatus = (args: {
  provider: string
  title: string
  active: boolean
  rules: Array<string>
}): ProviderStatus =>
  new ProviderStatus({
    provider: args.provider,
    title: args.title,
    active: args.active,
    rules: args.rules
  })

/**
 * An equivalent-rule overlap between a first-party provider rule and the
 * canonical Lens rule it duplicates.
 *
 * `providerRule` is the first-party rule id, `canonicalRule` is the Lens rule
 * it is equivalent to, and `rationale` explains the equivalence. The overlap
 * is derived from the explicit `foldstryxEquivalences` mapping and the
 * project's configured rules; it is advisory and never mutates config.
 *
 * @since 0.0.0
 */
export class RuleOverlap extends Schema.Class<RuleOverlap>("RuleOverlap")({
  providerRule: Schema.NonEmptyString,
  canonicalRule: Schema.NonEmptyString,
  rationale: Schema.NonEmptyString
}) {}

/**
 * Constructs a {@link RuleOverlap} value.
 *
 * @since 0.0.0
 */
export const makeRuleOverlap = (args: {
  providerRule: string
  canonicalRule: string
  rationale: string
}): RuleOverlap =>
  new RuleOverlap({
    providerRule: args.providerRule,
    canonicalRule: args.canonicalRule,
    rationale: args.rationale
  })

/**
 * A single redundant first-party rule observed in the unified gate, and the
 * canonical Lens rule it should be replaced with. This is the audit's own
 * Schema-backed migration row (the `review` operation's migration entries are
 * mapped into this shape so the audit contract does not depend on the
 * operation module).
 *
 * @since 0.0.0
 */
export class MigrationEntry extends Schema.Class<MigrationEntry>("MigrationEntry")({
  providerRule: Schema.NonEmptyString,
  canonicalRule: Schema.NonEmptyString,
  count: Schema.Number,
  recommendation: Schema.NonEmptyString
}) {}

/**
 * Constructs a {@link MigrationEntry} value.
 *
 * @since 0.0.0
 */
export const makeMigrationEntry = (args: {
  providerRule: string
  canonicalRule: string
  count: number
  recommendation: string
}): MigrationEntry =>
  new MigrationEntry({
    providerRule: args.providerRule,
    canonicalRule: args.canonicalRule,
    count: args.count,
    recommendation: args.recommendation
  })

/**
 * Counts of unified-gate findings by severity.
 *
 * @since 0.0.0
 */
export class GateSummary extends Schema.Class<GateSummary>("GateSummary")({
  total: Schema.Number,
  errors: Schema.Number,
  warnings: Schema.Number
}) {}

/**
 * Constructs a {@link GateSummary} value.
 *
 * @since 0.0.0
 */
export const makeGateSummary = (args: {
  total: number
  errors: number
  warnings: number
}): GateSummary =>
  new GateSummary({
    total: args.total,
    errors: args.errors,
    warnings: args.warnings
  })

/**
 * The current unified-gate findings for the audited project.
 *
 * `findings` are the aggregated {@link Finding} values from a unified-mode
 * review over the project; `migration` is the read-only migration report of
 * redundant first-party rules observed at overlapping locations; `diagnostics`
 * are the non-rule diagnostics (including unrecognized project diagnostics and
 * per-location migration notes); `summary` counts findings by severity;
 * `status` is the aggregate exit status. When oxlint is unavailable, `error`
 * carries the reason and the other fields are empty. When the project's
 * oxlint config could not be parsed and oxlint fell back to the built-in
 * config, `degraded` is true so the findings are not mistaken for the
 * project's own policy.
 *
 * @since 0.0.0
 */
export class GateFindings extends Schema.Class<GateFindings>("GateFindings")({
  findings: Schema.Array(Finding),
  migration: Schema.Array(MigrationEntry),
  diagnostics: Schema.Array(Diagnostic),
  summary: GateSummary,
  status: Schema.Number,
  error: Schema.OptionFromNullOr(Schema.String),
  degraded: Schema.Boolean
}) {}

/**
 * Constructs a {@link GateFindings} value.
 *
 * @since 0.0.0
 */
export const makeGateFindings = (args: {
  findings: Array<Finding>
  migration: Array<MigrationEntry>
  diagnostics: Array<Diagnostic>
  summary: GateSummary
  status: number
  error?: string | null
  degraded?: boolean
}): GateFindings =>
  new GateFindings({
    findings: args.findings,
    migration: args.migration,
    diagnostics: args.diagnostics,
    summary: args.summary,
    status: args.status,
    error: Option.fromNullishOr(args.error),
    degraded: args.degraded ?? false
  })

/**
 * An actionable migration recommendation in the audit.
 *
 * `kind` is a stable recommendation kind. `message` is the human-readable
 * recommendation. `detail` is an optional supporting detail.
 *
 * @since 0.0.0
 */
export const RecommendationKind = Schema.Literals([
  "migrate-overlap",
  "configure-lens",
  "fetch-pack",
  "resolve-dependency"
])
export type RecommendationKind = Schema.Schema.Type<typeof RecommendationKind>

/**
 * An actionable migration recommendation in the audit.
 *
 * @since 0.0.0
 */
export class Recommendation extends Schema.Class<Recommendation>("Recommendation")({
  kind: RecommendationKind,
  message: Schema.NonEmptyString,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link Recommendation} value.
 *
 * @since 0.0.0
 */
export const makeRecommendation = (args: {
  kind: RecommendationKind
  message: string
  detail?: string | null
}): Recommendation =>
  new Recommendation({
    kind: args.kind,
    message: args.message,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * A complete read-only staged-adoption audit for a project/workspace.
 *
 * `project` is the repository root (the lockfile and configuration boundary).
 * `workspace` is the selected workspace target or `null`. `resolution` is the
 * resolved Effect identity, `pack` the reference-pack verification, `oxlint`
 * the oxlint/Lens configuration status, and `oxlintScopes` the detected
 * config scopes. `providers` lists the active Lens/Foldstryx/StyleX providers
 * and their configured rules, `overlaps` the equivalent-rule overlaps, `gate`
 * the current unified-gate findings, and `recommendations` the actionable
 * migration recommendations. `diagnostics` drive the exit code.
 *
 * @since 0.0.0
 */
export class AdoptionAudit extends Schema.Class<AdoptionAudit>("AdoptionAudit")({
  project: Schema.NonEmptyString,
  workspace: Schema.OptionFromNullOr(Schema.NonEmptyString),
  resolution: Resolution,
  pack: PackVerificationResult,
  oxlint: OxlintStatus,
  oxlintScopes: OxlintScopes,
  providers: Schema.Array(ProviderStatus),
  overlaps: Schema.Array(RuleOverlap),
  gate: GateFindings,
  recommendations: Schema.Array(Recommendation),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs an {@link AdoptionAudit} value.
 *
 * @since 0.0.0
 */
export const makeAdoptionAudit = (args: {
  project: string
  workspace?: string | null
  resolution: Resolution
  pack: PackVerificationResult
  oxlint: OxlintStatus
  oxlintScopes: OxlintScopes
  providers: Array<ProviderStatus>
  overlaps: Array<RuleOverlap>
  gate: GateFindings
  recommendations: Array<Recommendation>
  diagnostics?: Array<Diagnostic>
}): AdoptionAudit =>
  new AdoptionAudit({
    project: args.project,
    workspace: Option.fromNullishOr(args.workspace),
    resolution: args.resolution,
    pack: args.pack,
    oxlint: args.oxlint,
    oxlintScopes: args.oxlintScopes,
    providers: args.providers,
    overlaps: args.overlaps,
    gate: args.gate,
    recommendations: args.recommendations,
    diagnostics: args.diagnostics ?? []
  })

export type { Diagnostic } from "./Finding.ts"
export type { PackVerificationResult } from "./PackVerifier.ts"
export type { Resolution } from "./Resolver.ts"
export type { OxlintStatus } from "./Setup.ts"
