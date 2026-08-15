/**
 * Provider registry for the unified `check` gate.
 *
 * Holds the registered {@link RuleProvider} values and resolves a raw
 * diagnostic to the first provider that recognizes it. The Lens provider is
 * registered by default; first-party project providers (Foldkit, StyleX) are
 * a later slice and register through the same seam.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { lensProvider } from "./lens.ts"
import { ProviderDiagnostic, type RawDiagnostic, type RuleProvider } from "./Provider.ts"

/**
 * A registry of {@link RuleProvider} values.
 *
 * @since 0.0.0
 */
export class ProviderRegistry {
  readonly #providers: ReadonlyArray<RuleProvider>

  constructor(providers: ReadonlyArray<RuleProvider> = [lensProvider]) {
    this.#providers = providers
  }

  /**
   * The registered providers in registration order.
   *
   * @since 0.0.0
   */
  readonly providers = (): ReadonlyArray<RuleProvider> => this.#providers

  /**
   * Finds the first provider that recognizes a raw diagnostic `code`.
   *
   * @since 0.0.0
   */
  readonly findProvider = (code: string): Option.Option<RuleProvider> =>
    Option.fromNullishOr(this.#providers.find((provider) => provider.recognizes(code)))

  /**
   * Normalizes a raw diagnostic through the first provider that recognizes it,
   * or returns `null` when no provider recognizes it.
   *
   * @since 0.0.0
   */
  readonly normalize = (diagnostic: RawDiagnostic, index: number): ProviderDiagnostic | null => {
    for (const provider of this.#providers) {
      if (provider.recognizes(diagnostic.code)) {
        return provider.normalize(diagnostic, index)
      }
    }
    return null
  }
}

/**
 * The default registry with the Lens provider registered.
 *
 * @since 0.0.0
 */
export const defaultRegistry = new ProviderRegistry()

export { lensProvider }
export type { RuleProvider } from "./Provider.ts"
