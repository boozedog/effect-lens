/**
 * Read-only `drift` operation: build a local {@link DriftReport} from the
 * project's resolved Effect identity and reference-pack verification.
 *
 * This is the local, offline slice of drift detection. It reports the
 * relationship between the declared/installed Effect dependency and the
 * available reference pack as drift entries, and records the local toolchain
 * for reproducibility. Full comparison against live upstream tooling is not
 * performed here; the CLI surfaces that limitation explicitly. This operation
 * never fetches packs and never mutates caches or configuration.
 *
 * @since 0.0.0
 */
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import {
  DriftEntry,
  DriftKind,
  DriftReport,
  DriftRole,
  makeDriftEntry,
  makeDriftReport,
  makeToolchainManifest
} from "../Drift.ts"
import { makePackageIdentity, PackageIdentity } from "../PackageIdentity.ts"
import * as PackVerifier from "../PackVerifier.ts"
import { UpstreamRef } from "../Provenance.ts"
import { Resolution, ResolutionStatus, resolveEffectIdentity } from "../Resolver.ts"

/**
 * Maps a {@link ResolutionStatus} to a {@link DriftKind} for the Effect
 * dependency entry.
 *
 * - `resolved` — declared and installed agree: `compatible`.
 * - `installed-mismatch` — declared and installed differ: `conflict`.
 * - `missing` — no declared Effect dependency: `missing`.
 * - `missing-lockfile` / `unsupported-lockfile` — the expected identity came
 *   from `package.json` (a range) rather than a reproducible lockfile: `stale`.
 *
 * @since 0.0.0
 */
const dependencyKind = (status: ResolutionStatus): DriftKind => {
  switch (status) {
    case "resolved":
      return "compatible"
    case "installed-mismatch":
      return "conflict"
    case "missing":
      return "missing"
    case "missing-lockfile":
    case "unsupported-lockfile":
      return "stale"
  }
}

/**
 * Maps a {@link PackStatus} to a {@link DriftKind} for the reference-pack
 * entry.
 *
 * - `complete` — the pack matches the expected Effect identity and is intact:
 *   `compatible`.
 * - `partial` / `stale` — the pack is missing files, has changed metadata, or
 *   lags the expected version: `stale`.
 * - `missing` — no pack for the expected identity: `missing`.
 *
 * @since 0.0.0
 */
const packKind = (status: PackVerifier.PackStatus): DriftKind => {
  switch (status) {
    case "complete":
      return "compatible"
    case "partial":
    case "stale":
      return "stale"
    case "missing":
      return "missing"
  }
}

/**
 * The package manager implied by the detected lockfile, or `null` when none
 * is present.
 *
 * @since 0.0.0
 */
const packageManagerOf = (lockfile: Resolution["lockfile"]): string | null => {
  switch (lockfile) {
    case "package-lock":
      return "npm"
    case "pnpm-lock":
      return "pnpm"
    case "yarn-lock":
      return "yarn"
    case "bun-lock":
      return "bun"
    case "missing":
      return null
  }
}

/**
 * The Effect package identity to record in the toolchain manifest. Prefers the
 * resolved expected identity; falls back to an explicit `unknown` placeholder
 * when the project declares no Effect dependency, so the manifest is always
 * populated without fabricating a version.
 *
 * @since 0.0.0
 */
const effectIdentityOf = (resolution: Resolution): PackageIdentity =>
  Option.getOrNull(resolution.expected) ??
    makePackageIdentity({ name: "effect", version: "unknown", source: "package.json" })

/**
 * Builds the Effect dependency drift entry from a {@link Resolution}.
 *
 * @since 0.0.0
 */
const dependencyEntry = (resolution: Resolution): DriftEntry =>
  makeDriftEntry({
    role: "dependency",
    packageIdentity: effectIdentityOf(resolution),
    kind: dependencyKind(resolution.status),
    detail: Option.getOrNull(resolution.detail)
  })

/**
 * Builds the reference-pack drift entry from a {@link PackVerificationResult}.
 * The pack's recorded upstream ref is the `expected` identity; `actual` is left
 * unset because live upstream comparison is not available in this offline
 * slice. Returns `null` when there is no pack and no expected identity to
 * anchor the entry.
 *
 * @since 0.0.0
 */
const packEntry = (result: PackVerifier.PackVerificationResult): DriftEntry | null => {
  const manifest = Option.getOrNull(result.pack)
  const identity = manifest?.packageIdentity ?? Option.getOrNull(result.resolution.expected)
  if (identity === null) return null
  const upstream: UpstreamRef | null = manifest?.upstream ?? null
  return makeDriftEntry({
    role: "pack",
    packageIdentity: identity,
    kind: packKind(result.status),
    expected: upstream,
    detail: Option.getOrNull(result.message)
  })
}

/**
 * Builds a local {@link DriftReport} for a project. Read-only: resolves the
 * Effect identity and verifies the reference pack, then records the resulting
 * drift entries and the local toolchain manifest.
 *
 * @since 0.0.0
 */
export const buildDriftReport = (args: {
  projectDir: string
  cacheDir: string
  lensVersion: string
  node?: string | null
}): DriftReport => {
  const resolution = resolveEffectIdentity(args.projectDir)
  const pack = PackVerifier.verifyReferencePack({
    projectDir: args.projectDir,
    cacheDir: args.cacheDir
  })
  const entries: Array<DriftEntry> = []
  // Always record the dependency entry so a missing dependency is surfaced as
  // a `missing` drift entry rather than silently absent.
  entries.push(dependencyEntry(resolution))
  const packEntryValue = packEntry(pack)
  if (packEntryValue !== null) {
    entries.push(packEntryValue)
  }
  const toolchain = makeToolchainManifest({
    lensVersion: args.lensVersion,
    effect: effectIdentityOf(resolution),
    packageManager: packageManagerOf(resolution.lockfile),
    node: args.node ?? process.version
  })
  return makeDriftReport({ toolchain, entries, generatedAt: DateTime.makeUnsafe(new Date()) })
}

export { DriftEntry, DriftKind, DriftReport, DriftRole, UpstreamRef }
export type { Resolution } from "../Resolver.ts"
