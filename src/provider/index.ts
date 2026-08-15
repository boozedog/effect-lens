/**
 * Rule provider seam for the unified `check` gate.
 *
 * Re-exports the provider contract, the Lens, Foldstryx, and StyleX providers, the
 * rule-equivalence mapping, and the registry so the seam is available from the
 * shared core public API (`src/index.ts`).
 *
 * @since 0.0.0
 */
export * as Equivalence from "./equivalence.ts"
export * as Foldstryx from "./foldstryx.ts"
export * as Lens from "./lens.ts"
export * as Provider from "./Provider.ts"
export * as Registry from "./registry.ts"
export * as Stylex from "./stylex.ts"

export { foldstryxEquivalences } from "./equivalence.ts"
export type { RuleEquivalence } from "./equivalence.ts"
export { foldstryxProvider } from "./foldstryx.ts"
export { lensProvider } from "./lens.ts"
export {
  CheckMode,
  DEFAULT_CHECK_MODE,
  ProviderDiagnostic,
  type RawDiagnostic,
  type RuleProvider
} from "./Provider.ts"
export { defaultRegistry, ProviderRegistry } from "./registry.ts"
export { stylexProvider } from "./stylex.ts"
export { stylexRuleIds } from "./stylex.ts"
