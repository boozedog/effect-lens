/**
 * Type declarations for the self-dogfood harness (`scripts/dogfood.mjs`).
 *
 * The harness is plain JavaScript (`.mjs`) so it can be spawned directly by
 * Node without a build step; this declaration file gives TypeScript consumers
 * (the test suite) a typed surface for `runDogfood`.
 *
 * @since 0.0.0
 */
export interface DogfoodCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/**
 * The raw CLI JSON payloads captured for each self-check, so tests can assert
 * the real outcomes rather than only the harness's summary strings. Each
 * field is `null` when the CLI produced no parseable JSON.
 *
 * @since 0.0.0
 */
export interface DogfoodPayloads {
  readonly doctor: {
    readonly machineOutput: { readonly status: number; readonly findings: Array<unknown> }
    readonly resolution: { readonly status: string }
    readonly pack: { readonly status: string }
  } | null
  readonly drift: {
    readonly machineOutput: { readonly status: number }
    readonly report: { readonly entries: Array<{ readonly kind: string }> }
  } | null
  readonly check: {
    readonly machineOutput: { readonly status: number; readonly findings: Array<unknown> }
    readonly oxlint: { readonly files: number }
  } | null
}

export interface DogfoodResult {
  readonly ok: boolean
  readonly checks: Array<DogfoodCheck>
  readonly payloads: DogfoodPayloads
}

export interface DogfoodOptions {
  readonly projectDir?: string
  readonly cacheDir?: string
  readonly path?: string
  readonly expectedEffectVersion?: string | null
}

export declare const runDogfood: (args: DogfoodOptions) => DogfoodResult
