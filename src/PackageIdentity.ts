/**
 * Identity of the Effect dependency as resolved from project metadata.
 *
 * This is the *package* identity (lockfile / `package.json` / installed
 * package) and is intentionally distinct from {@link ./Provenance.ts UpstreamRef}
 * (upstream source commit identity). A lockfile identity and an upstream
 * commit identity are different facts about the same dependency and MUST NOT
 * be conflated: the installed package version can be current while the
 * reference pack points at a stale commit, and vice versa.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Where a {@link PackageIdentity} was derived from. `lockfile` is preferred
 * because it is committed and reproducible; `installed` reflects what is on
 * disk; `package.json` is the declared intent; `registry` is a candidate
 * version observed from a registry snapshot (used by the read-only freshness
 * recommendation, never a project dependency).
 *
 * @since 0.0.0
 */
export const PackageSource = Schema.Literals([
  "package.json",
  "lockfile",
  "installed",
  "registry"
])
export type PackageSource = Schema.Schema.Type<typeof PackageSource>

/**
 * Identity of an npm package dependency.
 *
 * @since 0.0.0
 */
export class PackageIdentity extends Schema.Class<PackageIdentity>("PackageIdentity")({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  source: PackageSource,
  integrity: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * Constructs a {@link PackageIdentity} value.
 *
 * @since 0.0.0
 */
export const makePackageIdentity = (args: {
  name: string
  version: string
  source: PackageSource
  integrity?: string | null
}): PackageIdentity =>
  new PackageIdentity({
    name: args.name,
    version: args.version,
    source: args.source,
    integrity: Option.fromNullishOr(args.integrity)
  })

/**
 * True when two package identities refer to the same name and version,
 * regardless of how each was derived.
 *
 * @since 0.0.0
 */
export const samePackage = (a: PackageIdentity, b: PackageIdentity): boolean =>
  a.name === b.name && a.version === b.version
