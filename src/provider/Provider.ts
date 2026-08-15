/**
 * Rule provider seam for the unified `check` gate.
 *
 * A provider owns a set of rule ids and normalizes raw toolchain diagnostics
 * (e.g. oxlint JSON diagnostics) into {@link ProviderDiagnostic} values that
 * carry provider identity and provenance. The Lens strict rules are the first
 * provider, followed by the Foldstryx and StyleX first-party providers; all
 * register through the same seam without changing the review operation.
 *
 * @since 0.0.0
 */
import * as Schema from "effect/Schema"
import { FindingLocation } from "../Finding.ts"
import { Evidence, SourceKind } from "../Provenance.ts"
import { Severity } from "../Severity.ts"

/**
 * The raw diagnostic shape a provider consumes. This is the oxlint JSON
 * diagnostic shape; providers normalize it into a {@link ProviderDiagnostic}.
 *
 * @since 0.0.0
 */
export interface RawDiagnostic {
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

/**
 * A normalized diagnostic with provider provenance. `provider` is the stable
 * provider identity that produced the diagnostic; `rule` is the provider's
 * rule id when the diagnostic maps to a rule, or `null` for a non-rule
 * diagnostic.
 *
 * @since 0.0.0
 */
export class ProviderDiagnostic extends Schema.Class<ProviderDiagnostic>("ProviderDiagnostic")({
  provider: Schema.NonEmptyString,
  rule: Schema.OptionFromNullOr(Schema.NonEmptyString),
  severity: Severity,
  message: Schema.NonEmptyString,
  location: FindingLocation,
  code: Schema.NonEmptyString,
  source: SourceKind,
  evidence: Schema.Array(Evidence)
}) {}

/**
 * A rule provider: owns a set of rule ids and normalizes raw diagnostics.
 *
 * @since 0.0.0
 */
export interface RuleProvider {
  readonly id: string
  readonly title: string
  readonly ruleIds: ReadonlyArray<string>
  readonly recognizes: (code: string) => boolean
  readonly normalize: (diagnostic: RawDiagnostic, index: number) => ProviderDiagnostic | null
}

/**
 * The `check` gate mode.
 *
 * - `lens-only` — the existing single-package Lens behavior: a fresh scratch
 *   config loads the Lens rules, and unrecognized diagnostics are advisory
 *   `off` notes that do not affect the exit status.
 * - `unified` — a config-preserving gate: the target repository's oxlint
 *   config (ignores, overrides, rule settings) is preserved while the Lens
 *   rules are loaded, and unrecognized project diagnostics are surfaced as
 *   visible diagnostics with their raw oxlint severity.
 *
 * @since 0.0.0
 */
export const CheckMode = Schema.Literals(["lens-only", "unified"])
export type CheckMode = Schema.Schema.Type<typeof CheckMode>

/**
 * The default gate mode, preserving existing single-package Lens behavior.
 *
 * @since 0.0.0
 */
export const DEFAULT_CHECK_MODE: CheckMode = "lens-only"

export { FindingLocation }
export { Evidence, SourceKind }
export type { Severity as SeverityType } from "../Severity.ts"
