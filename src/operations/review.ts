/**
 * Read-only `review` operation: map oxlint diagnostics to stable Lens
 * {@link Finding} values and summarise them.
 *
 * Review normalizes each raw diagnostic through the registered rule providers
 * (the Lens strict rules are the first provider, followed by the Foldstryx
 * first-party provider) and maps the normalized diagnostics to stable
 * {@link Finding} values. Equivalent Lens and Foldstryx diagnostics that refer
 * to the same canonical rule and location collapse to a single finding, and
 * the redundant Foldstryx diagnostic becomes a migration diagnostic plus a
 * {@link MigrationReport} entry. Diagnostics that no provider
 * recognizes are never coerced into Lens findings; they are surfaced as
 * non-rule {@link Diagnostic} values. In `lens-only` mode (the default) those
 * are advisory `off` notes; in `unified` mode they are visible diagnostics
 * with their raw oxlint severity so unknown project diagnostics are never
 * silently dropped. The
 * result distinguishes hard errors, warnings (advisory), and the aggregate
 * exit status.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Exit, ExitStatus } from "../ExitStatus.ts"
import { Diagnostic, Finding, makeFinding, makeLocation } from "../Finding.ts"
import { providerRuleOf } from "../provider/equivalence.ts"
import {
  CheckMode,
  DEFAULT_CHECK_MODE,
  type ProviderDiagnostic,
  type RawDiagnostic,
  type RuleProvider
} from "../provider/Provider.ts"
import { ProviderRegistry } from "../provider/registry.ts"
import type { Severity } from "../Severity.ts"

/**
 * A source span reported by oxlint.
 *
 * @since 0.0.0
 */
export class OxlintSpan extends Schema.Class<OxlintSpan>("OxlintSpan")({
  line: Schema.Number,
  column: Schema.Number
}) {}

/**
 * A labelled span attached to an oxlint diagnostic.
 *
 * @since 0.0.0
 */
export class OxlintLabel extends Schema.Class<OxlintLabel>("OxlintLabel")({
  span: Schema.OptionFromNullOr(OxlintSpan)
}) {}

/**
 * The structured shape of an oxlint JSON diagnostic that Lens consumes. This
 * is the Schema-backed counterpart of the `OxlintDiagnostic` interface in
 * `src/plugin/toFinding.ts`; the two MUST stay in sync.
 *
 * @since 0.0.0
 */
export class OxlintDiagnostic extends Schema.Class<OxlintDiagnostic>("OxlintDiagnostic")({
  message: Schema.NonEmptyString,
  code: Schema.NonEmptyString,
  severity: Schema.Literals(["error", "warning"]),
  filename: Schema.NonEmptyString,
  labels: Schema.Array(OxlintLabel)
}) {}

/**
 * The input to a {@link review}: the raw oxlint diagnostics to map.
 *
 * @since 0.0.0
 */
export class ReviewInput extends Schema.Class<ReviewInput>("ReviewInput")({
  diagnostics: Schema.Array(OxlintDiagnostic)
}) {}

/**
 * Constructs a {@link ReviewInput} value.
 *
 * @since 0.0.0
 */
export const makeReviewInput = (args: {
  diagnostics: Array<OxlintDiagnostic>
}): ReviewInput => new ReviewInput({ diagnostics: args.diagnostics })

/**
 * Counts of findings by severity, so callers can distinguish hard errors from
 * advisory warnings at a glance.
 *
 * @since 0.0.0
 */
export class ReviewSummary extends Schema.Class<ReviewSummary>("ReviewSummary")({
  total: Schema.Number,
  errors: Schema.Number,
  warnings: Schema.Number
}) {}

/**
 * A single migration entry: a redundant first-party provider rule and the
 * canonical Lens rule it should be replaced with, plus how many overlapping
 * locations were observed.
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
 * The migration report: the redundant first-party provider rules observed in
 * a review and the canonical Lens rule each should be replaced with. It is
 * read-only and advisory — it never mutates config.
 *
 * @since 0.0.0
 */
export class MigrationReport extends Schema.Class<MigrationReport>("MigrationReport")({
  entries: Schema.Array(MigrationEntry)
}) {}

/**
 * The result of a {@link review}: the mapped {@link Finding} values, any
 * non-rule {@link Diagnostic} values, a severity {@link ReviewSummary}, the
 * {@link MigrationReport}, and the aggregate {@link ExitStatus}.
 *
 * @since 0.0.0
 */
export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  findings: Schema.Array(Finding),
  diagnostics: Schema.Array(Diagnostic),
  summary: ReviewSummary,
  migration: MigrationReport,
  status: ExitStatus
}) {}

const lineOf = (d: OxlintDiagnostic): number => {
  const span = Option.getOrNull(d.labels[0]?.span ?? Option.none())
  return span?.line ?? 1
}

/**
 * A stable location key for deduplication: `file:line:column`. Equivalent
 * diagnostics that refer to the same canonical rule at the same location share
 * a key and collapse to a single finding.
 *
 * @since 0.0.0
 */
const locationKeyOf = (pd: ProviderDiagnostic): string => {
  const column = Option.getOrNull(pd.location.column) ?? 0
  return `${pd.location.file}:${pd.location.line}:${column}`
}

/**
 * Runs a read-only `review` over the supplied oxlint diagnostics. Each raw
 * diagnostic is normalized through the registered rule providers; recognized
 * rule diagnostics become stable {@link Finding} values and unrecognized
 * diagnostics are surfaced as {@link Diagnostic} values (advisory `off` notes
 * in `lens-only` mode, visible diagnostics with their raw severity in
 * `unified` mode). Equivalent Lens and Foldstryx diagnostics at the same
 * canonical rule and location collapse to one finding; the redundant Foldstryx
 * diagnostic becomes a migration diagnostic and a {@link MigrationReport} entry.
 *
 * @since 0.0.0
 */
export const review = (args: {
  input: ReviewInput
  mode?: CheckMode
  providers?: ReadonlyArray<RuleProvider>
}): ReviewResult => {
  const mode = args.mode ?? DEFAULT_CHECK_MODE
  const registry = new ProviderRegistry(args.providers)
  const findings: Array<Finding> = []
  const diagnostics: Array<Diagnostic> = []
  const migrationByCanonical = new Map<
    string,
    { providerRule: string; canonicalRule: string; count: number }
  >()

  // Classify each raw diagnostic: a rule diagnostic (with a canonical rule),
  // a non-rule diagnostic, or an unrecognized diagnostic.
  const ruleDiags: Array<{ pd: ProviderDiagnostic; index: number; locationKey: string }> = []
  const nonRuleDiags: Array<{ pd: ProviderDiagnostic; index: number }> = []
  const unrecognized: Array<{ d: OxlintDiagnostic; index: number }> = []
  args.input.diagnostics.forEach((d, index) => {
    const normalized = registry.normalize(toRawDiagnostic(d), index)
    if (normalized === null) {
      unrecognized.push({ d, index })
    } else if (Option.isSome(normalized.rule)) {
      ruleDiags.push({ pd: normalized, index, locationKey: locationKeyOf(normalized) })
    } else {
      nonRuleDiags.push({ pd: normalized, index })
    }
  })

  // Group rule diagnostics by (canonical rule, location) so equivalent Lens
  // and Foldstryx diagnostics at the same location collapse to one finding
  // instead of producing duplicate gate findings.
  const groups = new Map<string, Array<{ pd: ProviderDiagnostic; index: number }>>()
  for (const r of ruleDiags) {
    const rule = Option.getOrNull(r.pd.rule) ?? r.pd.code
    const key = `${rule}@${r.locationKey}`
    const arr = groups.get(key) ?? []
    arr.push({ pd: r.pd, index: r.index })
    groups.set(key, arr)
  }

  for (const group of groups.values()) {
    const lens = group.filter((g) => g.pd.provider === "lens")
    const foldstryx = group.filter((g) => g.pd.provider === "foldstryx")
    const severity = strictestSeverity(group.map((g) => g.pd.severity))
    if (lens.length > 0) {
      // The canonical Lens finding is kept; each Foldstryx diagnostic at the
      // same rule/location is redundant and becomes a migration diagnostic.
      findings.push(providerDiagnosticToFinding(lens[0].pd, lens[0].index, severity))
      for (const f of foldstryx) {
        diagnostics.push(migrationDiagnostic(f.pd, f.index))
        recordMigration(migrationByCanonical, f.pd)
      }
    } else {
      // No Lens diagnostic: keep a single finding from the first member (a
      // Foldstryx diagnostic today, or any future provider) so the violation
      // is never silently dropped. Extra same-provider duplicates are skipped.
      findings.push(providerDiagnosticToFinding(group[0].pd, group[0].index, severity))
    }
  }

  for (const n of nonRuleDiags) {
    diagnostics.push(providerDiagnosticToDiagnostic(n.pd, n.index))
  }
  for (const u of unrecognized) {
    diagnostics.push(unrecognizedDiagnostic(u.d, u.index, mode))
  }

  const migration = new MigrationReport({
    entries: [...migrationByCanonical.values()]
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh array
      .sort((a, b) => a.providerRule.localeCompare(b.providerRule))
      .map((e) =>
        new MigrationEntry({
          providerRule: e.providerRule,
          canonicalRule: e.canonicalRule,
          count: e.count,
          recommendation:
            `Replace ${e.providerRule} with ${e.canonicalRule}; Lens enforces the same rule with catalog evidence.`
        })
      )
  })

  const errors = findings.filter((f) => f.severity === "error").length
  const warnings = findings.filter((f) => f.severity === "warning").length
  const status = errors > 0 ? Exit.Error : warnings > 0 ? Exit.Warning : Exit.Ok

  return new ReviewResult({
    findings,
    diagnostics,
    summary: new ReviewSummary({
      total: findings.length,
      errors,
      warnings
    }),
    migration,
    status
  })
}

/**
 * Converts a Schema-backed {@link OxlintDiagnostic} to the plain
 * {@link RawDiagnostic} shape a provider consumes.
 *
 * @since 0.0.0
 */
const toRawDiagnostic = (d: OxlintDiagnostic): RawDiagnostic => ({
  message: d.message,
  code: d.code,
  severity: d.severity,
  filename: d.filename,
  labels: d.labels.map((label) => {
    const span = Option.getOrNull(label.span)
    return span === null ? {} : { span }
  })
})

/**
 * Converts a normalized {@link ProviderDiagnostic} with a rule into a stable
 * {@link Finding}, attaching the rule catalog evidence.
 *
 * @since 0.0.0
 */
const providerDiagnosticToFinding = (
  d: ProviderDiagnostic,
  index: number,
  severity: Severity = d.severity
): Finding => {
  const ruleId = Option.getOrNull(d.rule)
  return makeFinding({
    id: `f-${index}`,
    rule: ruleId ?? d.code,
    provider: d.provider,
    severity,
    source: d.source,
    message: d.message,
    location: d.location,
    evidence: [...d.evidence]
  })
}

/**
 * The strictest severity in a set: `error` beats `warning` beats `off`. When
 * equivalent Lens and Foldstryx diagnostics at the same rule/location carry
 * different severities, the collapsed finding takes the strictest so a
 * blocking violation is never downgraded to advisory.
 *
 * @since 0.0.0
 */
const strictestSeverity = (severities: ReadonlyArray<Severity>): Severity =>
  severities.includes("error") ? "error" : severities.includes("warning") ? "warning" : "off"

/**
 * Builds the migration {@link Diagnostic} for a redundant Foldstryx
 * diagnostic that overlaps a canonical Lens finding at the same rule/location.
 * It is advisory (`warning`) and never mutates config.
 *
 * @since 0.0.0
 */
const migrationDiagnostic = (pd: ProviderDiagnostic, index: number): Diagnostic => {
  const canonical = Option.getOrNull(pd.rule) ?? pd.code
  const providerRule = Option.getOrNull(providerRuleOf(canonical)) ?? canonical
  return new Diagnostic({
    id: `review-migration-${index}`,
    severity: "warning",
    message:
      `${providerRule} is redundant with ${canonical} at ${pd.location.file}:${pd.location.line}; ` +
      `migrate to ${canonical}`,
    location: Option.some(pd.location)
  })
}

/**
 * Records a redundant Foldstryx rule in the migration report, keyed by its
 * canonical Lens rule so the report lists each redundant rule once with a
 * count of overlapping locations.
 *
 * @since 0.0.0
 */
const recordMigration = (
  map: Map<string, { providerRule: string; canonicalRule: string; count: number }>,
  pd: ProviderDiagnostic
): void => {
  const canonical = Option.getOrNull(pd.rule) ?? pd.code
  const providerRule = Option.getOrNull(providerRuleOf(canonical)) ?? canonical
  const existing = map.get(canonical)
  if (existing !== undefined) {
    existing.count += 1
  } else {
    map.set(canonical, { providerRule, canonicalRule: canonical, count: 1 })
  }
}

/**
 * Converts a normalized {@link ProviderDiagnostic} without a rule into a
 * non-rule {@link Diagnostic}.
 *
 * @since 0.0.0
 */
const providerDiagnosticToDiagnostic = (d: ProviderDiagnostic, index: number): Diagnostic =>
  new Diagnostic({
    id: `review-provider-${d.provider}-${index}`,
    severity: d.severity,
    message: d.message,
    location: Option.some(d.location)
  })

/**
 * Builds the non-rule {@link Diagnostic} for a raw diagnostic that no provider
 * recognizes. In `lens-only` mode it is an advisory `off` note; in `unified`
 * mode it is surfaced with its raw oxlint severity so unknown project
 * diagnostics are never silently dropped.
 *
 * @since 0.0.0
 */
const unrecognizedDiagnostic = (
  d: OxlintDiagnostic,
  index: number,
  mode: CheckMode
): Diagnostic => {
  const unified = mode === "unified"
  return new Diagnostic({
    id: `review-unmapped-${index}`,
    // In unified mode preserve the raw oxlint severity so a project error rule
    // stays blocking (exit 2); in lens-only mode it is an advisory off note.
    severity: unified ? d.severity : "off",
    message: unified
      ? `diagnostic not in any provider catalog: ${d.code}`
      : `diagnostic not in Lens catalog: ${d.code}`,
    location: Option.some(makeLocation({ file: d.filename, line: lineOf(d) }))
  })
}

export type { CheckMode, RuleProvider } from "../provider/Provider.ts"

export { ExitStatus, Finding }
export type { Diagnostic } from "../Finding.ts"
