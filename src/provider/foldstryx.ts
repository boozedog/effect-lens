/**
 * The Foldstryx first-party rule provider.
 *
 * Registered through the provider seam as a {@link RuleProvider}. It owns the
 * supported Foldstryx rule ids and normalizes oxlint diagnostics whose code
 * maps to a supported Foldstryx rule into {@link ProviderDiagnostic} values
 * with `provider: "foldstryx"` provenance.
 *
 * A supported Foldstryx rule is normalized toward the canonical Lens rule it
 * is equivalent to (see {@link ./equivalence.ts}): the normalized diagnostic
 * carries the canonical Lens rule id, source kind, and catalog evidence, so
 * the `review` operation can compare it directly with a Lens diagnostic and
 * avoid duplicate gate findings during migration. The `provider: "foldstryx"`
 * field preserves the Foldstryx provenance so the overlap and migration path
 * stays explainable.
 *
 * The provider never requires Foldstryx to be installed: it only recognizes
 * `foldstryx(...)` diagnostic codes. A Foldstryx rule with no Lens equivalent
 * is not recognized here and is surfaced as an unrecognized diagnostic rather
 * than being coerced into a Lens rule.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { makeLocation } from "../Finding.ts"
import { toRuleId } from "../plugin/toFinding.ts"
import { findRule } from "../rules/index.ts"
import { canonicalOf, foldstryxEquivalences } from "./equivalence.ts"
import { ProviderDiagnostic, type RawDiagnostic, type RuleProvider } from "./Provider.ts"

/**
 * The Foldstryx first-party rule provider.
 *
 * @since 0.0.0
 */
export const foldstryxProvider: RuleProvider = {
  id: "foldstryx",
  title: "Foldstryx rules",
  ruleIds: foldstryxEquivalences.map((e) => e.providerRule),
  recognizes: (code: string): boolean => Option.isSome(canonicalOf(toRuleId(code))),
  normalize: (diagnostic: RawDiagnostic, _index: number): ProviderDiagnostic | null => {
    const canonical = canonicalOf(toRuleId(diagnostic.code))
    if (Option.isNone(canonical)) return null
    const lensRule = findRule(canonical.value)
    if (Option.isNone(lensRule)) return null
    const span = diagnostic.labels?.[0]?.span
    return new ProviderDiagnostic({
      provider: "foldstryx",
      rule: Option.some(lensRule.value.id),
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: makeLocation({
        file: diagnostic.filename,
        line: span?.line ?? 1,
        column: span?.column ?? null
      }),
      code: diagnostic.code,
      source: lensRule.value.kind === "lens-strict" ? "lens-strict" : "upstream",
      evidence: [...lensRule.value.evidence]
    })
  }
}

export { ProviderDiagnostic }
export { foldstryxEquivalences } from "./equivalence.ts"
export type { RuleEquivalence } from "./equivalence.ts"
export type { RawDiagnostic, RuleProvider } from "./Provider.ts"
