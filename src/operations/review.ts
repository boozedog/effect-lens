/**
 * Read-only `review` operation: map oxlint diagnostics to stable Lens
 * {@link Finding} values and summarise them.
 *
 * Review reuses the existing rule catalog and the `toFinding` seam — it does
 * not duplicate rule policy. Diagnostics whose rule id is not in the Lens
 * catalog are never coerced into Lens findings; they are surfaced as
 * non-rule {@link Diagnostic} values instead. The result distinguishes hard
 * errors, warnings (advisory), and the aggregate exit status.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Exit, ExitStatus } from "../ExitStatus.ts"
import { Diagnostic, Finding, makeLocation } from "../Finding.ts"
import {
  type OxlintDiagnostic as OxlintDiagnosticInterface,
  toFinding
} from "../plugin/toFinding.ts"

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

const toOxlintInterface = (d: OxlintDiagnostic): OxlintDiagnosticInterface => ({
  message: d.message,
  code: d.code,
  severity: d.severity,
  filename: d.filename,
  labels: d.labels.map((label) => {
    const span = Option.getOrNull(label.span)
    return span === null ? {} : { span }
  })
})

const lineOf = (d: OxlintDiagnostic): number => {
  const span = Option.getOrNull(d.labels[0]?.span ?? Option.none())
  return span?.line ?? 1
}

/**
 * Runs a read-only `review` over the supplied oxlint diagnostics. Lens-catalog
 * diagnostics are mapped through `toFinding` into stable {@link Finding}
 * values; non-catalog diagnostics are surfaced as {@link Diagnostic} values.
 *
 * @since 0.0.0
 */
export const review = (args: { input: ReviewInput }): ReviewResult => {
  const findings: Array<Finding> = []
  const diagnostics: Array<Diagnostic> = []

  args.input.diagnostics.forEach((d, index) => {
    const mapped = toFinding(toOxlintInterface(d), index)
    if (Option.isSome(mapped)) {
      findings.push(mapped.value)
    } else {
      diagnostics.push(
        new Diagnostic({
          id: `review-unmapped-${index}`,
          severity: "off",
          message: `diagnostic not in Lens catalog: ${d.code}`,
          location: Option.some(makeLocation({ file: d.filename, line: lineOf(d) }))
        })
      )
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

export { ExitStatus, Finding }
export type { Diagnostic } from "../Finding.ts"
