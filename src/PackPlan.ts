/**
 * Read-only reference-pack acquisition planning over the existing resolver and
 * verifier contracts (issue #4, first slice).
 *
 * This module answers: "for this project's exact Effect identity, what would
 * acquiring a reference pack require, and is an explicit catalog source
 * available?" It NEVER fetches, writes, deletes, or updates cache files, and it
 * never mutates the project. It is planning/catalog only. It performs the
 * resolver/verifier's read-only filesystem reads (lockfile, cache manifests)
 * but never writes anything.
 *
 * The target identity is the resolver's exact expected identity derived from
 * committed project metadata. A catalog entry is selected ONLY by exact
 * name+version match (`samePackage`) — never by range, compatibility, or "any
 * newer" selection. The catalog input is explicit: callers pass the entries
 * directly (or load them from a read-only baseline directory via
 * {@link loadPackCatalog}); the planner never guesses a remote URL from an
 * untrusted version string.
 *
 * Catalog rule: an intact, exact local pack is already complete regardless of
 * the catalog (you already have it). The catalog gates acquisition: a missing
 * or divergent pack is only `fetch-required` / `partial-pack-present` when an
 * explicit catalog entry pins the expected content; with no entry it is
 * `catalog-entry-missing`. A declared specifier that is not an exact version
 * (for example a `^4.0.0` range from `package.json` after an unparseable or
 * unsupported lockfile) is `resolution-unavailable`.
 *
 * Network acquisition and atomic promotion are intentionally deferred to a
 * later slice. This plan only classifies pack state and orders read-only
 * actions. It is fully JSON-serializable via its Schema contracts.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Diagnostic } from "./Finding.ts"
import { PackageIdentity, samePackage } from "./PackageIdentity.ts"
import * as PackVerifier from "./PackVerifier.ts"
import { PackManifest } from "./ReferencePack.ts"
import * as Resolver from "./Resolver.ts"

/**
 * The ordered, read-only acquisition outcome for a project's exact Effect
 * identity.
 *
 * - `already-complete` — an exact, intact local pack is present. A complete
 *   exact pack is already complete even without a catalog entry (the catalog
 *   only gates acquisition, not presence).
 * - `fetch-required` — the exact pack is absent and an explicit catalog entry
 *   exists; acquisition is required (deferred to a later slice).
 * - `stale-pack-present` — a same-name pack for a different version is cached;
 *   the exact pack is absent and a catalog entry exists.
 * - `partial-pack-present` — the exact pack is present but does not match the
 *   catalog baseline (missing files, changed metadata, or a divergent catalog
 *   entry).
 * - `catalog-entry-missing` — the target is a known exact version but no
 *   catalog entry provides it; acquisition cannot be planned.
 * - `resolution-unavailable` — the project's expected Effect identity cannot be
 *   resolved, or the declared specifier is not an exact version (for example a
 *   range from `package.json` after an unparseable lockfile).
 *
 * @since 0.0.0
 */
export const PackPlanAction = Schema.Literals([
  "already-complete",
  "fetch-required",
  "stale-pack-present",
  "partial-pack-present",
  "catalog-entry-missing",
  "resolution-unavailable"
])
export type PackPlanAction = Schema.Schema.Type<typeof PackPlanAction>

/**
 * A single ordered, read-only step in an acquisition plan.
 *
 * @since 0.0.0
 */
export class PackPlanStep extends Schema.Class<PackPlanStep>("PackPlanStep")({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  action: PackPlanAction,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link PackPlanStep} value.
 *
 * @since 0.0.0
 */
export const makePackPlanStep = (args: {
  id: string
  title: string
  action: PackPlanAction
  detail?: string | null
}): PackPlanStep =>
  new PackPlanStep({
    id: args.id,
    title: args.title,
    action: args.action,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * An explicit catalog of reference-pack entries available for acquisition.
 *
 * Each entry is a {@link PackManifest} that fully specifies the exact pack
 * (package version, upstream source identity, integrity, included paths,
 * attribution). `baseline` records where the catalog came from (a directory or
 * label) so the source input is never guessed. This catalog is the ONLY place
 * the planner learns a source; it never invents a URL from a version string.
 *
 * @since 0.0.0
 */
export class PackCatalog extends Schema.Class<PackCatalog>("PackCatalog")({
  name: Schema.NonEmptyString,
  baseline: Schema.OptionFromNullOr(Schema.NonEmptyString),
  entries: Schema.Array(PackManifest)
}) {}

/**
 * Constructs a {@link PackCatalog} value.
 *
 * @since 0.0.0
 */
export const makePackCatalog = (args: {
  name: string
  baseline?: string | null
  entries: Array<PackManifest>
}): PackCatalog =>
  new PackCatalog({
    name: args.name,
    baseline: Option.fromNullishOr(args.baseline),
    entries: args.entries
  })

/**
 * A complete read-only acquisition plan for a project.
 *
 * `project` and `cacheDir` are the inspected paths. `resolution` is the
 * resolver outcome; `expected` is the exact target Effect identity or `null`.
 * `catalogEntry` is the selected exact catalog entry (or `null`); `localPack`
 * is the cached pack for the same name/version when one exists, and
 * `verification` its detailed check against the catalog baseline when one is
 * selected (or the on-disk check otherwise). `action` is the aggregate
 * outcome, `steps` the ordered read-only actions, `diagnostics` drive exit
 * policy, and `message` is a human-readable summary.
 *
 * @since 0.0.0
 */
export class PackAcquisitionPlan extends Schema.Class<PackAcquisitionPlan>(
  "PackAcquisitionPlan"
)({
  project: Schema.NonEmptyString,
  cacheDir: Schema.NonEmptyString,
  resolution: Resolver.Resolution,
  expected: Schema.OptionFromNullOr(PackageIdentity),
  catalogEntry: Schema.OptionFromNullOr(PackManifest),
  localPack: Schema.OptionFromNullOr(PackManifest),
  verification: Schema.OptionFromNullOr(PackVerifier.PackVerification),
  action: PackPlanAction,
  steps: Schema.Array(PackPlanStep),
  diagnostics: Schema.Array(Diagnostic),
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link PackAcquisitionPlan} value.
 *
 * @since 0.0.0
 */
export const makePackAcquisitionPlan = (args: {
  project: string
  cacheDir: string
  resolution: Resolver.Resolution
  expected?: PackageIdentity | null
  catalogEntry?: PackManifest | null
  localPack?: PackManifest | null
  verification?: PackVerifier.PackVerification | null
  action: PackPlanAction
  steps: Array<PackPlanStep>
  diagnostics?: Array<Diagnostic>
  message?: string | null
}): PackAcquisitionPlan =>
  new PackAcquisitionPlan({
    project: args.project,
    cacheDir: args.cacheDir,
    resolution: args.resolution,
    expected: Option.fromNullishOr(args.expected),
    catalogEntry: Option.fromNullishOr(args.catalogEntry),
    localPack: Option.fromNullishOr(args.localPack),
    verification: Option.fromNullishOr(args.verification),
    action: args.action,
    steps: args.steps,
    diagnostics: args.diagnostics ?? [],
    message: Option.fromNullishOr(args.message)
  })

/**
 * Selects the catalog entry that matches `expected` exactly by name and
 * version, or `null` when none matches. This is the documented catalog rule: an
 * exact `samePackage` match only. It never selects a merely compatible or newer
 * version, and it never consults the remote.
 *
 * @since 0.0.0
 */
export const selectCatalogEntry = (
  catalog: ReadonlyArray<PackManifest>,
  expected: PackageIdentity
): PackManifest | null =>
  catalog.find((entry) => samePackage(entry.packageIdentity, expected)) ?? null

/**
 * Loads every decodable pack manifest from a catalog baseline directory
 * (each entry at `<catalogDir>/<id>/manifest.json`). Read-only: it never
 * fetches or mutates anything. An unreadable or empty baseline yields an empty
 * catalog, never an error. Undecodable entries are skipped silently.
 *
 * @since 0.0.0
 */
export const loadPackCatalog = (catalogDir: string): PackCatalog => {
  const entries: Array<PackManifest> = []
  let names: Array<string>
  try {
    names = readdirSync(catalogDir)
  } catch {
    return makePackCatalog({ name: "empty", baseline: catalogDir, entries })
  }
  for (const name of names) {
    const manifestPath = join(catalogDir, name, "manifest.json")
    if (!existsSync(manifestPath)) continue
    let content: string
    try {
      content = readFileSync(manifestPath, "utf8")
    } catch {
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(content)
    } catch {
      continue
    }
    const decoded = Schema.decodeUnknownOption(PackManifest)(json)
    if (Option.isSome(decoded)) entries.push(decoded.value)
  }
  return makePackCatalog({ name: "baseline", baseline: catalogDir, entries })
}

const diag = (
  id: string,
  severity: "warning" | "error" | "off",
  message: string
): Diagnostic => new Diagnostic({ id, severity, message, location: Option.none() })

/**
 * True when `version` is an exact semver (major.minor.patch with optional
 * prerelease/build), as opposed to a range specifier such as `^4.0.0`. Only an
 * exact version can select an exact catalog entry.
 *
 * @since 0.0.0
 */
const isExactVersion = (version: string): boolean =>
  /^\d+(\.\d+){2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)

const resolutionUnavailable = (args: {
  projectDir: string
  cacheDir: string
  resolution: Resolver.Resolution
  expected: PackageIdentity | null
  detail: string
}): PackAcquisitionPlan =>
  makePackAcquisitionPlan({
    project: args.projectDir,
    cacheDir: args.cacheDir,
    resolution: args.resolution,
    expected: args.expected,
    action: "resolution-unavailable",
    steps: [
      makePackPlanStep({
        id: "resolution",
        title: "Resolve exact Effect identity",
        action: "resolution-unavailable",
        detail: args.detail
      })
    ],
    diagnostics: [diag("plan-resolution-unavailable", "error", args.detail)],
    message: `cannot resolve the project's expected Effect identity: ${args.detail}`
  })

/**
 * Plans read-only reference-pack acquisition for a project against an explicit
 * catalog. It performs only read-only filesystem reads (resolver/verifier); it
 * never writes, deletes, or fetches.
 *
 * Decision rules (documented):
 * 1. No target identity -> `resolution-unavailable`.
 * 2. Declared specifier is not an exact version -> `resolution-unavailable`.
 * 3. No exact catalog entry: an intact exact local pack is `already-complete`;
 *    otherwise `catalog-entry-missing` (plus a stale step only when the cached
 *    pack is genuinely a different version).
 * 4. Exact catalog entry present: absent exact pack -> `stale-pack-present` /
 *    `fetch-required`; present exact pack -> `already-complete` when it matches
 *    the catalog baseline, else `partial-pack-present`.
 *
 * @since 0.0.0
 */
export const planPackAcquisition = (args: {
  projectDir: string
  cacheDir: string
  catalog: PackCatalog | ReadonlyArray<PackManifest>
}): PackAcquisitionPlan => {
  const { projectDir, cacheDir } = args
  const entries = Array.isArray(args.catalog)
    ? args.catalog
    : (args.catalog as PackCatalog).entries
  const resolution = Resolver.resolveEffectIdentity(projectDir)
  const expected = Option.getOrNull(resolution.expected)
  const local = PackVerifier.verifyReferencePack({ projectDir, cacheDir })
  const localPack = Option.getOrNull(local.pack)
  const localVerification = Option.getOrNull(local.verification)

  // 1. No target identity at all.
  if (expected === null) {
    return resolutionUnavailable({
      projectDir,
      cacheDir,
      resolution,
      expected: null,
      detail: Option.getOrNull(resolution.detail) ??
        "no effect dependency declared in lockfile or package.json"
    })
  }

  // 2. Declared specifier is not an exact version (e.g. a range from
  //    package.json after an unparseable or unsupported lockfile). An exact
  //    catalog entry cannot be selected for it.
  if (!isExactVersion(expected.version)) {
    return resolutionUnavailable({
      projectDir,
      cacheDir,
      resolution,
      expected,
      detail: Option.getOrNull(resolution.detail) ??
        `declared effect specifier ${expected.version} is not an exact version`
    })
  }

  const catalogEntry = selectCatalogEntry(entries, expected)

  // 3. No exact catalog entry.
  if (catalogEntry === null) {
    // An intact exact local pack is already complete even without a source
    // baseline; acquisition is moot.
    if (local.status === "complete") {
      return makePackAcquisitionPlan({
        project: projectDir,
        cacheDir,
        resolution,
        expected,
        localPack,
        verification: localVerification,
        action: "already-complete",
        steps: [
          makePackPlanStep({
            id: "pack-present",
            title: "Reference pack already complete",
            action: "already-complete",
            detail: `exact pack ${localPack?.id} is intact`
          })
        ],
        message: `reference pack ${localPack?.id} is already complete`
      })
    }

    const lockfileHint = Option.getOrNull(resolution.detail)
    const message = lockfileHint !== null
      ? `no catalog entry provides effect ${expected.version} (${lockfileHint})`
      : `no catalog entry provides effect ${expected.version}`
    const diagnostics: Array<Diagnostic> = [
      diag("plan-catalog-entry-missing", "warning", message)
    ]
    const steps: Array<PackPlanStep> = [
      makePackPlanStep({
        id: "catalog-entry",
        title: "Provide an explicit catalog entry",
        action: "catalog-entry-missing",
        detail: message
      })
    ]
    // Surface a genuinely different-version cached pack; an exact intact pack is
    // already handled above and must not be mislabeled stale.
    if (local.status === "stale" && localPack !== null) {
      diagnostics.push(
        diag(
          "plan-stale-pack-present",
          "warning",
          `cached pack ${localPack.id} is for effect ${localPack.effectVersion}`
        )
      )
      steps.push(
        makePackPlanStep({
          id: "stale-pack",
          title: "Replace stale cached pack",
          action: "stale-pack-present",
          detail: `cached pack ${localPack.id} is for effect ${localPack.effectVersion}`
        })
      )
    }
    return makePackAcquisitionPlan({
      project: projectDir,
      cacheDir,
      resolution,
      expected,
      localPack,
      verification: localVerification,
      action: "catalog-entry-missing",
      steps,
      diagnostics,
      message
    })
  }

  // 4. Exact catalog entry present.
  const exactPresent = local.status === "complete" || local.status === "partial"

  // 4a. No exact local pack.
  if (!exactPresent) {
    if (local.status === "stale") {
      return makePackAcquisitionPlan({
        project: projectDir,
        cacheDir,
        resolution,
        expected,
        catalogEntry,
        localPack,
        verification: localVerification,
        action: "stale-pack-present",
        steps: [
          makePackPlanStep({
            id: "replace-stale-pack",
            title: "Replace stale reference pack",
            action: "stale-pack-present",
            detail: Option.getOrNull(local.message) ?? "cached pack is for a different version"
          })
        ],
        diagnostics: [
          diag(
            "plan-stale-pack-present",
            "warning",
            Option.getOrNull(local.message) ?? "cached pack is for a different version"
          )
        ],
        message: Option.getOrNull(local.message) ?? "cached pack is stale"
      })
    }
    // Truly missing.
    return makePackAcquisitionPlan({
      project: projectDir,
      cacheDir,
      resolution,
      expected,
      catalogEntry,
      action: "fetch-required",
      steps: [
        makePackPlanStep({
          id: "fetch-pack",
          title: "Acquire reference pack",
          action: "fetch-required",
          detail: "catalog entry found; network acquisition deferred to a later slice"
        })
      ],
      message: `acquisition required for effect ${expected.version}`
    })
  }

  // 4b. Exact pack present: verify it against the catalog baseline so a local
  //     pack that diverges from the intended content (different id, integrity,
  //     included paths, or upstream) is not reported as done.
  const baseline = PackVerifier.verifyPack({ manifest: catalogEntry, expected, cacheDir })
  const divergent = baseline.missingFiles.length > 0 || baseline.metadataChanged
  if (divergent) {
    return makePackAcquisitionPlan({
      project: projectDir,
      cacheDir,
      resolution,
      expected,
      catalogEntry,
      localPack,
      verification: baseline,
      action: "partial-pack-present",
      steps: [
        makePackPlanStep({
          id: "repair-pack",
          title: "Repair reference pack to match catalog",
          action: "partial-pack-present",
          detail: Option.getOrNull(baseline.message) ?? "cached pack diverges from the catalog"
        })
      ],
      diagnostics: [
        diag(
          "plan-partial-pack-present",
          "warning",
          Option.getOrNull(baseline.message) ?? "cached pack diverges from the catalog"
        )
      ],
      message: Option.getOrNull(baseline.message) ?? "cached pack diverges from the catalog"
    })
  }
  return makePackAcquisitionPlan({
    project: projectDir,
    cacheDir,
    resolution,
    expected,
    catalogEntry,
    localPack,
    verification: baseline,
    action: "already-complete",
    steps: [
      makePackPlanStep({
        id: "pack-present",
        title: "Reference pack already complete",
        action: "already-complete",
        detail: `exact pack ${localPack?.id ?? catalogEntry.id} matches the catalog baseline`
      })
    ],
    message: `reference pack ${localPack?.id ?? catalogEntry.id} is already complete`
  })
}

export { PackManifest, PackVerifier, Resolver }
export type { PackageIdentity } from "./PackageIdentity.ts"
