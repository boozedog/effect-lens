/**
 * Maps an oxlint diagnostic to a Lens {@link Finding}.
 *
 * This is the seam between the oxlint plugin and the shared core contracts:
 * rule identity (the `lens/<rule>` code) and evidence (from the rule catalog)
 * are preserved so CLI, pi, and Git gates consume one stable finding shape.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { type Finding, makeFinding, makeLocation } from "../Finding.ts"
import { findRule } from "../rules/index.ts"
import type { Severity } from "../Severity.ts"

/**
 * The structured shape of an oxlint JSON diagnostic that Lens consumes.
 *
 * @since 0.0.0
 */
export interface OxlintDiagnostic {
  readonly message: string
  readonly code: string
  readonly severity: "error" | "warning"
  readonly filename: string
  readonly labels?: ReadonlyArray<{
    readonly span?: {
      readonly line: number
      readonly column: number
    }
  }>
}

const severityOf = (severity: "error" | "warning"): Severity =>
  severity === "error" ? "error" : "warning"

/**
 * Converts an oxlint diagnostic `code` (`plugin(rule)`, e.g.
 * `lens(no-async-function)`) to the Lens rule id (`lens/no-async-function`).
 * Codes that do not match the `plugin(rule)` shape are returned unchanged.
 *
 * @since 0.0.0
 */
export const toRuleId = (code: string): string => {
  const match = /^([^(]+)\(([^)]+)\)$/.exec(code)
  return match === null ? code : `${match[1]}/${match[2]}`
}

/**
 * Maps an oxlint diagnostic to a Lens {@link Finding}.
 *
 * Returns `Option.none()` when the diagnostic's rule id is not in the Lens
 * catalog (so non-Lens diagnostics are never coerced into Lens findings).
 *
 * @since 0.0.0
 */
export const toFinding = (
  diagnostic: OxlintDiagnostic,
  index: number
): Option.Option<Finding> => {
  const rule = findRule(toRuleId(diagnostic.code))
  if (Option.isNone(rule)) return Option.none()
  const span = diagnostic.labels?.[0]?.span
  const location = makeLocation({
    file: diagnostic.filename,
    line: span?.line ?? 1,
    column: span?.column ?? null
  })
  const finding = makeFinding({
    id: `f-${index}`,
    rule: rule.value.id,
    severity: severityOf(diagnostic.severity),
    source: rule.value.kind === "lens-strict" ? "lens-strict" : "upstream",
    message: diagnostic.message,
    location,
    evidence: [...rule.value.evidence]
  })
  return Option.some(finding)
}
