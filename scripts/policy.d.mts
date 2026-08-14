/**
 * Type declarations for the policy/metadata validation harness
 * (`scripts/policy.mjs`).
 *
 * The harness is plain JavaScript (`.mjs`) so it can be spawned directly by
 * Node without a build step; this declaration file gives TypeScript consumers
 * (the test suite) a typed surface for `runPolicy`.
 *
 * @since 0.0.0
 */
export interface PolicyCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/**
 * The raw validation payloads captured for each policy check, so tests can
 * assert the real outcomes rather than only the harness's summary strings.
 *
 * @since 0.0.0
 */
export interface PolicyPayloads {
  readonly waivers: {
    readonly file: string
    readonly count: number
    readonly problems: Array<string>
    readonly expired: Array<string>
  }
  readonly packs: {
    readonly cacheDir: string
    readonly packs: Array<{
      readonly id: string
      readonly effectVersion: string
      readonly includedPaths: number
    }>
    readonly problems: Array<string>
  }
  readonly guidance: {
    readonly cacheDir: string
    readonly packs: number
    readonly records: number
    readonly problems: Array<string>
  }
}

export interface PolicyResult {
  readonly ok: boolean
  readonly checks: Array<PolicyCheck>
  readonly payloads: PolicyPayloads
  readonly unsupported: Array<string>
}

export interface PolicyOptions {
  readonly repoRoot?: string
  readonly waiversFile?: string
  readonly cacheDir?: string
}

export declare const runPolicy: (args: PolicyOptions) => PolicyResult
