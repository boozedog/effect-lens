/**
 * Read-only `review` operation: map oxlint diagnostics to stable Lens
 * {@link Finding} values and summarise them.
 *
 * Review normalizes each raw diagnostic through the registered rule providers
 * (the Lens strict rules are the first provider) and maps the normalized
 * diagnostics to stable {@link Finding} values. Diagnostics that no provider
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
import {
  CheckMode,
  DEFAULT_CHECK_MODE,
  type ProviderDiagnostic,
  type RawDiagnostic,
  type RuleProvider
} from "../provider/Provider.ts"
import { ProviderRegistry } from "../provider/registry.ts"

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
 * The result of a {@link review}: the mapped {@link Finding} values, any
 * non-rule {@link Diagnostic} values, a severity {@link ReviewSummary}, and
 * the aggregate {@link ExitStatus}.
 *
 * @since 0.0.0
 */
export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  findings: Schema.Array(Finding),
  diagnostics: Schema.Array(Diagnostic),
  summary: ReviewSummary,
  status: ExitStatus
}) {}

const lineOf = (d: OxlintDiagnostic): number => {
  const span = Option.getOrNull(d.labels[0]?.span ?? Option.none())
  return span?.line ?? 1
}

/**
 * Runs a read-only `review` over the supplied oxlint diagnostics. Each raw
 * diagnostic is normalized through the registered rule providers; recognized
 * rule diagnostics become stable {@link Finding} values and unrecognized
 * diagnostics are surfaced as {@link Diagnostic} values (advisory `off` notes
 * in `lens-only` mode, visible diagnostics with their raw severity in
 * `unified` mode).
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

  args.input.diagnostics.forEach((d, index) => {
    const normalized = registry.normalize(toRawDiagnostic(d), index)
    if (normalized !== null) {
      if (Option.isSome(normalized.rule)) {
        findings.push(providerDiagnosticToFinding(normalized, index))
      } else {
        diagnostics.push(providerDiagnosticToDiagnostic(normalized, index))
      }
    } else {
      diagnostics.push(unrecognizedDiagnostic(d, index, mode))
    }
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
const providerDiagnosticToFinding = (d: ProviderDiagnostic, index: number): Finding => {
  const ruleId = Option.getOrNull(d.rule)
  return makeFinding({
    id: `f-${index}`,
    rule: ruleId ?? d.code,
    severity: d.severity,
    source: d.source,
    message: d.message,
    location: d.location,
    evidence: [...d.evidence]
  })
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
