/**
 * The Lens strict-rule provider.
 *
 * Registered through the provider seam as the first {@link RuleProvider}. It
 * owns the Lens rule catalog ids and normalizes oxlint diagnostics whose code
 * maps to a catalog rule into {@link ProviderDiagnostic} values with
 * `provider: "lens"` provenance. It reuses the existing rule catalog and the
 * `toRuleId` code conversion — it does not duplicate rule policy.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { makeLocation } from "../Finding.ts"
import { toRuleId } from "../plugin/toFinding.ts"
import { findRule, rules } from "../rules/index.ts"
import { ProviderDiagnostic, type RawDiagnostic, type RuleProvider } from "./Provider.ts"

/**
 * The Lens strict-rule provider.
 *
 * @since 0.0.0
 */
export const lensProvider: RuleProvider = {
  id: "lens",
  title: "Effect Lens strict rules",
  ruleIds: rules.map((rule) => rule.id),
  recognizes: (code: string): boolean => Option.isSome(findRule(toRuleId(code))),
  normalize: (diagnostic: RawDiagnostic, _index: number): ProviderDiagnostic | null => {
    const rule = findRule(toRuleId(diagnostic.code))
    if (Option.isNone(rule)) return null
    const span = diagnostic.labels?.[0]?.span
    return new ProviderDiagnostic({
      provider: "lens",
      rule: Option.some(rule.value.id),
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: makeLocation({
        file: diagnostic.filename,
        line: span?.line ?? 1,
        column: span?.column ?? null
      }),
      code: diagnostic.code,
      source: rule.value.kind === "lens-strict" ? "lens-strict" : "upstream",
      evidence: [...rule.value.evidence]
    })
  }
}

export { ProviderDiagnostic }
export type { RawDiagnostic, RuleProvider } from "./Provider.ts"
