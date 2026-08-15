/**
 * Explicit rule-equivalence mapping between first-party project providers and
 * the canonical Lens rule catalog.
 *
 * During migration a project may run both a first-party provider (Foldstryx)
 * and the Lens strict rules. The mapping below states, explicitly and in one
 * place, which Foldstryx rule is equivalent to which canonical Lens rule. The
 * `review` operation uses it to avoid duplicate gate findings when equivalent
 * diagnostics refer to the same rule and location, and to produce a migration
 * report that recommends the Lens equivalent without mutating config.
 *
 * The mapping is the single source of truth for equivalence. A Foldstryx rule
 * that has no Lens equivalent is intentionally absent here: the Foldstryx
 * provider does not recognize it, so it is surfaced as an unrecognized
 * diagnostic rather than being coerced into a Lens rule.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"

/**
 * A single explicit equivalence between a first-party provider rule and a
 * canonical Lens rule.
 *
 * @since 0.0.0
 */
export interface RuleEquivalence {
  readonly providerRule: string
  readonly canonicalRule: string
  readonly rationale: string
}

/**
 * The supported Foldstryx → Lens rule equivalences. Each entry maps a
 * Foldstryx rule id to the canonical Lens rule that enforces the same
 * Effect-first policy.
 *
 * @since 0.0.0
 */
export const foldstryxEquivalences: ReadonlyArray<RuleEquivalence> = [
  {
    providerRule: "foldstryx/no-async-function",
    canonicalRule: "lens/no-async-function",
    rationale: "Foldstryx bans async functions; Lens enforces the same Effect-first rule."
  },
  {
    providerRule: "foldstryx/no-await-expression",
    canonicalRule: "lens/no-await-expression",
    rationale: "Foldstryx bans await expressions; Lens enforces the same Effect-first rule."
  },
  {
    providerRule: "foldstryx/no-new-promise",
    canonicalRule: "lens/no-new-promise",
    rationale: "Foldstryx bans manual Promise construction; Lens enforces the same rule."
  }
]

/**
 * Resolves the canonical Lens rule id for a first-party provider rule id, or
 * `Option.none()` when the provider rule has no Lens equivalent.
 *
 * @since 0.0.0
 */
export const canonicalOf = (providerRule: string): Option.Option<string> =>
  Option.fromNullishOr(
    foldstryxEquivalences.find((e) => e.providerRule === providerRule)?.canonicalRule
  )

/**
 * Resolves the first-party provider rule id for a canonical Lens rule id, or
 * `Option.none()` when the Lens rule has no provider equivalent.
 *
 * @since 0.0.0
 */
export const providerRuleOf = (canonicalRule: string): Option.Option<string> =>
  Option.fromNullishOr(
    foldstryxEquivalences.find((e) => e.canonicalRule === canonicalRule)?.providerRule
  )
