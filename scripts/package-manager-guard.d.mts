/**
 * Type declarations for the package-manager guard (`scripts/package-manager-guard.mjs`).
 *
 * The guard is plain JavaScript (`.mjs`) so it can be spawned directly by
 * Node without a build step; this declaration file gives TypeScript consumers
 * (the test suite) a typed surface for `runPackageManagerGuard`.
 *
 * @since 0.0.0
 */
export interface PackageManagerGuardResult {
  readonly ok: boolean
  readonly detail: string
  /** The active project/CI workflow files that were scanned. */
  readonly checked: Array<string>
  /** Human-readable `file:line` references to active pnpm tool usage. */
  readonly problems: Array<string>
}

export interface PackageManagerGuardOptions {
  readonly repoRoot?: string
}

export declare const runPackageManagerGuard: (
  args?: PackageManagerGuardOptions
) => PackageManagerGuardResult
