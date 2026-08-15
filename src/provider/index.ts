/**
 * Rule provider seam for the unified `check` gate.
 *
 * Re-exports the provider contract, the Lens provider, and the registry so the
 * seam is available from the shared core public API (`src/index.ts`).
 *
 * @since 0.0.0
 */
export * as Lens from "./lens.ts"
export * as Provider from "./Provider.ts"
export * as Registry from "./registry.ts"

export { lensProvider } from "./lens.ts"
export {
  CheckMode,
  DEFAULT_CHECK_MODE,
  ProviderDiagnostic,
  type RawDiagnostic,
  type RuleProvider
} from "./Provider.ts"
export { defaultRegistry, ProviderRegistry } from "./registry.ts"
