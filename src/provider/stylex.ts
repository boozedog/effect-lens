/**
 * The StyleX first-party rule provider.
 *
 * Registered through the provider seam as a {@link RuleProvider}. It owns the
 * supported StyleX rule ids and normalizes oxlint diagnostics whose code maps
 * to a supported StyleX rule into {@link ProviderDiagnostic} values with
 * `provider: "stylex"` provenance.
 *
 * Unlike the Foldstryx provider, StyleX rules have no canonical Lens
 * equivalent: they enforce StyleX style policy, not Effect-first policy. A
 * supported StyleX diagnostic is therefore normalized to its own StyleX rule
 * id with `source: "project"` provenance and StyleX plugin evidence, so the
 * `review` operation keeps it as a distinct finding rather than coercing it
 * into a Lens rule or a migration entry. The `provider: "stylex"` field
 * preserves the StyleX provenance so the finding is never mislabeled as
 * upstream Effect guidance or Lens strict policy.
 *
 * The provider recognizes an explicit supported StyleX rule catalog rather
 * than treating every arbitrary `stylex(...)` code as trusted: a StyleX rule
 * outside the catalog is not recognized here and is surfaced as an
 * unrecognized diagnostic. The provider never requires StyleX to be installed:
 * it only recognizes `stylex(...)` diagnostic codes, so ordinary Lens-only
 * projects are unaffected.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { makeLocation } from "../Finding.ts"
import { toRuleId } from "../plugin/toFinding.ts"
import { makeEvidence } from "../Provenance.ts"
import { ProviderDiagnostic, type RawDiagnostic, type RuleProvider } from "./Provider.ts"

/**
 * The supported StyleX rule catalog. These are the official
 * `@stylexjs/eslint-plugin` rule ids (as of plugin version `0.19.0`) that Lens
 * recognizes and normalizes. Oxlint reports them as `stylex(<rule>)` codes
 * (the plugin is loaded under the `stylex` alias); the provider maps those to
 * the `stylex/<rule>` ids below. A StyleX rule outside this catalog is not
 * recognized by the provider and is surfaced as an unrecognized diagnostic
 * rather than being trusted blindly.
 *
 * @since 0.0.0
 */
export const stylexRuleIds: ReadonlyArray<string> = [
  "stylex/valid-styles",
  "stylex/valid-shorthands",
  "stylex/no-unused",
  "stylex/no-legacy-contextual-styles",
  "stylex/no-conflicting-props",
  "stylex/no-nonstandard-styles",
  "stylex/no-lookahead-selectors",
  "stylex/sort-keys",
  "stylex/enforce-extension"
]

/**
 * The evidence source for a StyleX rule finding: the official StyleX ESLint
 * plugin that defines the rule.
 *
 * @since 0.0.0
 */
const STYLEX_EVIDENCE_SOURCE = "StyleX official ESLint plugin (@stylexjs/eslint-plugin)"

/**
 * The StyleX first-party rule provider.
 *
 * @since 0.0.0
 */
export const stylexProvider: RuleProvider = {
  id: "stylex",
  title: "StyleX rules",
  ruleIds: stylexRuleIds,
  recognizes: (code: string): boolean => stylexRuleIds.includes(toRuleId(code)),
  normalize: (diagnostic: RawDiagnostic, _index: number): ProviderDiagnostic | null => {
    const ruleId = toRuleId(diagnostic.code)
    if (!stylexRuleIds.includes(ruleId)) return null
    const span = diagnostic.labels?.[0]?.span
    return new ProviderDiagnostic({
      provider: "stylex",
      rule: Option.some(ruleId),
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: makeLocation({
        file: diagnostic.filename,
        line: span?.line ?? 1,
        column: span?.column ?? null
      }),
      code: diagnostic.code,
      source: "project",
      evidence: [
        makeEvidence({
          source: STYLEX_EVIDENCE_SOURCE,
          ref: "official @stylexjs/eslint-plugin rule catalog"
        })
      ]
    })
  }
}

export { ProviderDiagnostic }
export type { RawDiagnostic, RuleProvider } from "./Provider.ts"
