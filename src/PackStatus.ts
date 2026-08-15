/**
 * Read-only baseline/status reporting for Lens-managed reference packs
 * (issue #4, baseline lifecycle slice; issue #15 dependency).
 *
 * This module answers the question issue #15 depends on: "does this project's
 * exact target Effect version have a verified matching pack, and what
 * baseline/candidate does the explicit catalog offer?" It layers the explicit
 * catalog baseline on top of the existing resolver and verifier so a target
 * can report its pack state as one of `unresolved`, `absent`, `stale`,
 * `corrupt`, `complete`, `mismatched`, or `verified`.
 *
 * It is strictly read-only: it performs only the resolver/verifier's read-only
 * filesystem reads (lockfile, cache manifests) and never fetches, writes,
 * deletes, or updates cache files. It never mutates the project. The catalog
 * input is explicit (callers pass the entries directly or load them from a
 * read-only baseline directory via {@link PackPlan.loadPackCatalog}); the
 * report never invents a remote source or "any newer" checkout. Candidate
 * baselines are reported as read-only availability for the freshness
 * recommendation (issue #15); no release-age or channel policy is applied here.
 *
 * The distinction between `complete`, `mismatched`, and `verified`:
 * - `complete` — the exact pack is present and self-consistent (every file it
 *   declares is on disk), but no catalog baseline entry exists to verify it
 *   against. Presence beats source: the pack is usable, just not baseline-pinned.
 * - `mismatched` — the exact pack is present and self-consistent but diverges
 *   from the catalog baseline (different id, upstream ref, integrity, included
 *   paths, or a changed on-disk manifest relative to the baseline).
 * - `verified` — the exact pack is present, self-consistent, AND matches the
 *   catalog baseline.
 *
 * `corrupt` reports a self-inconsistent exact pack (missing its own declared
 * files); `stale` reports a cached pack for a different version; `absent`
 * reports no pack for the package at all; `unresolved` reports that no exact
 * target identity could be derived (no dependency, a range specifier, or a
 * failed workspace target).
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Diagnostic } from "./Finding.ts"
import { PackageIdentity, samePackage } from "./PackageIdentity.ts"
import * as PackPlan from "./PackPlan.ts"
import * as PackVerifier from "./PackVerifier.ts"
import { PackManifest, PackVerification } from "./ReferencePack.ts"
import * as Resolver from "./Resolver.ts"

/**
 * The read-only baseline status of a project's exact target reference pack.
 *
 * - `unresolved` — no exact target Effect identity could be derived (no
 *   declared dependency, a range specifier, or a failed workspace target).
 * - `absent` — no reference pack exists for the package at all.
 * - `stale` — a cached pack is for a different Effect version; the exact pack
 *   is absent.
 * - `corrupt` — the exact pack is present but self-inconsistent (missing its
 *   own declared files).
 * - `complete` — the exact pack is present and self-consistent, but no catalog
 *   baseline entry exists to verify it against.
 * - `mismatched` — the exact pack is present and self-consistent but diverges
 *   from the catalog baseline.
 * - `verified` — the exact pack is present, self-consistent, and matches the
 *   catalog baseline.
 *
 * @since 0.0.0
 */
export const PackBaselineStatus = Schema.Literals([
  "unresolved",
  "absent",
  "stale",
  "corrupt",
  "complete",
  "mismatched",
  "verified"
])
export type PackBaselineStatus = Schema.Schema.Type<typeof PackBaselineStatus>

/**
 * A complete, Schema-backed read-only report of a project's reference-pack
 * baseline status.
 *
 * `project`, `cacheDir`, and `workspace` identify the inspected target.
 * `resolution` is the resolver outcome and `expected` the exact target Effect
 * identity (or `null`). `localPack` is the cached best-match pack manifest and
 * `localVerification` its self-check. `catalogEntry` is the exact catalog
 * baseline match (or `null`); `baselineVerification` the check of the local
 * pack against that baseline (present only when a baseline entry exists).
 * `candidateBaselines` are the catalog entries for the same package name that
 * are not the exact match, surfaced read-only for the freshness recommendation
 * (issue #15).
 * `status` is the aggregate {@link PackBaselineStatus}; `diagnostics` drive
 * exit policy and `message` is a human-readable summary.
 *
 * @since 0.0.0
 */
export class PackStatusReport extends Schema.Class<PackStatusReport>(
  "PackStatusReport"
)({
  project: Schema.NonEmptyString,
  cacheDir: Schema.NonEmptyString,
  workspace: Schema.OptionFromNullOr(Schema.NonEmptyString),
  resolution: Resolver.Resolution,
  expected: Schema.OptionFromNullOr(PackageIdentity),
  localPack: Schema.OptionFromNullOr(PackManifest),
  catalogEntry: Schema.OptionFromNullOr(PackManifest),
  localVerification: Schema.OptionFromNullOr(PackVerification),
  baselineVerification: Schema.OptionFromNullOr(PackVerification),
  candidateBaselines: Schema.Array(PackManifest),
  status: PackBaselineStatus,
  diagnostics: Schema.Array(Diagnostic),
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link PackStatusReport} value.
 *
 * @since 0.0.0
 */
export const makePackStatusReport = (args: {
  project: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  expected?: PackageIdentity | null
  localPack?: PackManifest | null
  catalogEntry?: PackManifest | null
  localVerification?: PackVerification | null
  baselineVerification?: PackVerification | null
  candidateBaselines?: Array<PackManifest>
  status: PackBaselineStatus
  diagnostics?: Array<Diagnostic>
  message?: string | null
}): PackStatusReport =>
  new PackStatusReport({
    project: args.project,
    cacheDir: args.cacheDir,
    workspace: Option.fromNullishOr(args.workspace),
    resolution: args.resolution,
    expected: Option.fromNullishOr(args.expected),
    localPack: Option.fromNullishOr(args.localPack),
    catalogEntry: Option.fromNullishOr(args.catalogEntry),
    localVerification: Option.fromNullishOr(args.localVerification),
    baselineVerification: Option.fromNullishOr(args.baselineVerification),
    candidateBaselines: args.candidateBaselines ?? [],
    status: args.status,
    diagnostics: args.diagnostics ?? [],
    message: Option.fromNullishOr(args.message)
  })

const diag = (
  id: string,
  severity: "warning" | "error",
  message: string
): Diagnostic => new Diagnostic({ id, severity, message, location: Option.none() })

/**
 * Builds a {@link PackStatusReport} whose status is `unresolved` because no
 * exact target identity could be derived. It carries the resolver outcome and
 * a blocking error diagnostic; no pack lookup is attempted.
 *
 * @since 0.0.0
 */
const unresolved = (args: {
  projectDir: string
  cacheDir: string
  workspace?: string | null | undefined
  resolution: Resolver.Resolution
  expected: PackageIdentity | null
}): PackStatusReport => {
  const detail = Option.getOrNull(args.resolution.detail) ??
    (args.expected === null
      ? "no effect dependency declared in lockfile or package.json"
      : `declared effect specifier ${args.expected.version} is not an exact version`)
  return makePackStatusReport({
    project: args.projectDir,
    cacheDir: args.cacheDir,
    workspace: args.workspace,
    resolution: args.resolution,
    expected: args.expected,
    status: "unresolved",
    diagnostics: [diag("status-resolution-unavailable", "error", detail)],
    message: `cannot report reference-pack status: ${detail}`
  })
}

/**
 * Reports the read-only baseline status of a project's exact target reference
 * pack against an explicit catalog.
 *
 * It resolves the exact Effect identity, locates and self-verifies the local
 * pack, selects the exact catalog baseline entry, verifies the local pack
 * against that baseline when one exists, and lists the same-name candidate
 * baselines the catalog offers. It performs only the resolver/verifier's
 * read-only filesystem reads; it never fetches, writes, deletes, or updates
 * cache files.
 *
 * Decision rules (documented):
 * 1. No exact target identity (no dependency, range specifier, or failed
 *    workspace target) -> `unresolved`.
 * 2. No pack for the package -> `absent`; a cached different-version pack
 *    -> `stale`.
 * 3. Exact pack present but missing its own declared files -> `corrupt`.
 * 4. Exact pack present and self-consistent: with no catalog baseline entry
 *    -> `complete`; with a matching entry -> `verified`; with a divergent
 *    entry -> `mismatched`.
 *
 * @since 0.0.0
 */
export const reportPackStatus = (args: {
  projectDir: string
  cacheDir: string
  catalog: PackPlan.PackCatalog | ReadonlyArray<PackManifest>
  workspace?: string | undefined
}): PackStatusReport => {
  const { projectDir, cacheDir } = args
  const entries: ReadonlyArray<PackManifest> = Array.isArray(args.catalog)
    ? (args.catalog as ReadonlyArray<PackManifest>)
    : (args.catalog as PackPlan.PackCatalog).entries
  const local = PackVerifier.verifyReferencePack({
    projectDir,
    cacheDir,
    workspace: args.workspace
  })
  const resolution = local.resolution
  const expected = Option.getOrNull(resolution.expected)

  // 1. No exact target identity.
  if (
    resolution.status === "workspace-ambiguous" ||
    resolution.status === "workspace-unresolved" ||
    expected === null ||
    !PackPlan.isExactVersion(expected.version)
  ) {
    return unresolved({
      projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected
    })
  }

  const catalogEntry = PackPlan.selectCatalogEntry(entries, expected)
  const candidateBaselines = entries
    .filter(
      (entry) =>
        entry.packageIdentity.name === expected.name &&
        !samePackage(entry.packageIdentity, expected)
    )
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh filtered array
    .sort((a, b) => a.id.localeCompare(b.id))

  const localPack = Option.getOrNull(local.pack)
  const localVerification = Option.getOrNull(local.verification)

  // 2. No exact pack: absent, or stale when a different-version pack is cached.
  if (local.status === "missing") {
    return makePackStatusReport({
      project: projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected,
      catalogEntry,
      candidateBaselines,
      status: "absent",
      diagnostics: [
        diag(
          "status-pack-absent",
          "warning",
          `no reference pack found for effect ${expected.version}`
        )
      ],
      message: `no reference pack found for effect ${expected.version}`
    })
  }
  if (local.status === "stale") {
    return makePackStatusReport({
      project: projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected,
      localPack,
      localVerification,
      catalogEntry,
      candidateBaselines,
      status: "stale",
      diagnostics: [
        diag(
          "status-pack-stale",
          "warning",
          Option.getOrNull(local.message) ?? "cached pack is for a different effect version"
        )
      ],
      message: Option.getOrNull(local.message) ?? "cached pack is stale"
    })
  }

  // 3. Exact pack present but self-inconsistent (its own declared files are
  //    missing). The read-only verifier reports this as `partial`.
  if (local.status === "partial") {
    return makePackStatusReport({
      project: projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected,
      localPack,
      localVerification,
      catalogEntry,
      candidateBaselines,
      status: "corrupt",
      diagnostics: [
        diag(
          "status-pack-corrupt",
          "warning",
          Option.getOrNull(local.message) ?? "reference pack is missing its declared files"
        )
      ],
      message: Option.getOrNull(local.message) ?? "reference pack is corrupt"
    })
  }

  // 4. Exact pack present and self-consistent. With no catalog baseline entry
  //    the pack is `complete` (presence beats source). With an entry, verify
  //    the local pack against it directly (like {@link PackPlan
  //    planPackAcquisition}): the comparison reads the catalog entry's
  //    directory under the cache, so a changed on-disk manifest or missing
  //    baseline file is caught, and a local pack cached under a different id
  //    for the same version is itself a divergence (the baseline id is not
  //    satisfied).
  if (catalogEntry === null) {
    return makePackStatusReport({
      project: projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected,
      localPack,
      localVerification,
      candidateBaselines,
      status: "complete",
      message: `reference pack ${
        localPack?.id ?? "unknown"
      } is complete (no catalog baseline to verify against)`
    })
  }

  const baselineVerification = PackVerifier.verifyPack({
    manifest: catalogEntry,
    expected,
    cacheDir
  })
  const divergent = baselineVerification.missingFiles.length > 0 ||
    baselineVerification.metadataChanged
  if (divergent) {
    // When the catalog baseline's own directory is absent from the cache, the
    // divergence is that the baseline id is not satisfied (the exact version is
    // cached under a different id, or not at all). Name the unsatisfied
    // baseline id rather than reporting a generic "missing files" message that
    // would be indistinguishable from a corrupt pack.
    const baselineIdMissing = !existsSync(join(cacheDir, catalogEntry.id, "manifest.json"))
    const detail = baselineIdMissing
      ? `catalog baseline pack ${catalogEntry.id} is not cached; the cached pack for this version does not satisfy the baseline id`
      : Option.getOrNull(baselineVerification.message) ??
        "reference pack diverges from the catalog baseline"
    return makePackStatusReport({
      project: projectDir,
      cacheDir,
      workspace: args.workspace,
      resolution,
      expected,
      localPack,
      localVerification,
      catalogEntry,
      baselineVerification,
      candidateBaselines,
      status: "mismatched",
      diagnostics: [diag("status-pack-mismatched", "warning", detail)],
      message: detail
    })
  }
  return makePackStatusReport({
    project: projectDir,
    cacheDir,
    workspace: args.workspace,
    resolution,
    expected,
    localPack,
    localVerification,
    catalogEntry,
    baselineVerification,
    candidateBaselines,
    status: "verified",
    message: `reference pack ${
      localPack?.id ?? catalogEntry.id
    } is verified against the catalog baseline`
  })
}

export { PackManifest, PackVerifier, Resolver }
export type { PackageIdentity } from "./PackageIdentity.ts"
