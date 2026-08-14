/**
 * Verification of Lens-managed reference packs against the on-disk cache and
 * the project's expected Effect identity.
 *
 * The cache layout is `cacheDir/<packId>/manifest.json` plus the pack's
 * included files under `cacheDir/<packId>/<includedPath>`. Packs are located
 * by scanning `cacheDir/<packId>/manifest.json` for one whose package identity
 * matches the expected Effect version. Verification is read-only: it never
 * fetches or mutates network/cache state.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PackageIdentity, samePackage } from "./PackageIdentity.ts"
import { PackManifest, PackStatus, PackVerification } from "./ReferencePack.ts"
import { Resolution, resolveEffectIdentity } from "./Resolver.ts"

/**
 * The result of verifying a project's reference pack against the cache.
 *
 * `resolution` is the project's resolved Effect identity; `pack` is the
 * matching pack manifest (when one exists); `verification` is the detailed
 * check (when a pack exists); `status` is the aggregate `PackStatus`; and
 * `message` is a human-readable summary.
 *
 * @since 0.0.0
 */
export class PackVerificationResult extends Schema.Class<PackVerificationResult>(
  "PackVerificationResult"
)({
  resolution: Resolution,
  pack: Schema.OptionFromNullOr(PackManifest),
  verification: Schema.OptionFromNullOr(PackVerification),
  status: PackStatus,
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link PackVerificationResult} value.
 *
 * @since 0.0.0
 */
export const makePackVerificationResult = (args: {
  resolution: Resolution
  pack?: PackManifest | null
  verification?: PackVerification | null
  status: PackStatus
  message?: string | null
}): PackVerificationResult =>
  new PackVerificationResult({
    resolution: args.resolution,
    pack: Option.fromNullishOr(args.pack),
    verification: Option.fromNullishOr(args.verification),
    status: args.status,
    message: Option.fromNullishOr(args.message)
  })

/**
 * Finds the reference pack in `cacheDir` whose package identity matches the
 * expected Effect identity exactly (name and version), or `null` when none
 * exists. This is a strict content locator: it never returns a pack for a
 * different version. Use {@link verifyReferencePack} to surface a
 * version-lagging pack as `stale`.
 *
 * @since 0.0.0
 */
export const findPack = (cacheDir: string, expected: PackageIdentity): PackManifest | null => {
  return readPacks(cacheDir).find((pack) => samePackage(pack.packageIdentity, expected)) ?? null
}

/**
 * Verifies a {@link PackManifest} against the on-disk cache and the expected
 * Effect identity. Read-only: reports missing files, changed metadata, and
 * staleness without mutating anything.
 *
 * @since 0.0.0
 */
export const verifyPack = (args: {
  manifest: PackManifest
  expected: PackageIdentity
  cacheDir: string
}): PackVerification => {
  const { manifest, expected, cacheDir } = args
  const packDir = join(cacheDir, manifest.id)
  const missingFiles = manifest.includedPaths.filter((path) => !existsSync(join(packDir, path)))
  const stored = readStoredManifest(packDir)
  const metadataChanged = stored !== null && !manifestsEqual(stored, manifest)
  const stale = !samePackage(manifest.packageIdentity, expected)
  const message = buildMessage({ manifest, expected, missingFiles, metadataChanged, stale })
  return new PackVerification({
    manifest,
    missingFiles,
    metadataChanged,
    stale,
    message: Option.fromNullishOr(message)
  })
}

/**
 * Resolves the project's expected Effect identity, locates the matching
 * reference pack in the cache, and verifies it. Produces a `PackStatus` of
 * `missing`, `stale`, `partial`, or `complete`.
 *
 * @since 0.0.0
 */
export const verifyReferencePack = (args: {
  projectDir: string
  cacheDir: string
}): PackVerificationResult => {
  const resolution = resolveEffectIdentity(args.projectDir)
  const expected = Option.getOrNull(resolution.expected)
  if (expected === null) {
    // No declared effect dependency: nothing to locate.
    return makePackVerificationResult({
      resolution,
      status: "missing",
      message: "no effect dependency declared; cannot locate a reference pack"
    })
  }
  const manifest = findPack(args.cacheDir, expected)
  if (manifest === null) {
    // No exact-version pack. A same-name pack for a different version is stale.
    const sameName = readPacks(args.cacheDir).find(
      (pack) => pack.packageIdentity.name === expected.name
    ) ?? null
    if (sameName !== null) {
      const verification = verifyPack({ manifest: sameName, expected, cacheDir: args.cacheDir })
      return makePackVerificationResult({
        resolution,
        pack: sameName,
        verification,
        status: "stale",
        message: Option.getOrNull(verification.message)
      })
    }
    return makePackVerificationResult({
      resolution,
      status: "missing",
      message: `no reference pack found for effect ${expected.version}`
    })
  }
  const verification = verifyPack({ manifest, expected, cacheDir: args.cacheDir })
  let status: PackStatus
  if (verification.missingFiles.length > 0 || verification.metadataChanged) {
    status = "partial"
  } else {
    status = "complete"
  }
  return makePackVerificationResult({
    resolution,
    pack: manifest,
    verification,
    status,
    message: Option.getOrNull(verification.message)
  })
}

/**
 * Reads every decodable pack manifest from `cacheDir`. Read-only.
 *
 * @internal
 */
const readPacks = (cacheDir: string): Array<PackManifest> => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return []
  }
  const packs: Array<PackManifest> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(cacheDir, entry.name, "manifest.json")
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
    if (Option.isSome(decoded)) packs.push(decoded.value)
  }
  return packs
}

const readStoredManifest = (packDir: string): PackManifest | null => {
  const path = join(packDir, "manifest.json")
  if (!existsSync(path)) return null
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  return Option.getOrNull(Schema.decodeUnknownOption(PackManifest)(json))
}

const manifestsEqual = (a: PackManifest, b: PackManifest): boolean =>
  JSON.stringify(Schema.encodeSync(PackManifest)(a)) ===
    JSON.stringify(Schema.encodeSync(PackManifest)(b))

const buildMessage = (args: {
  manifest: PackManifest
  expected: PackageIdentity
  missingFiles: Array<string>
  metadataChanged: boolean
  stale: boolean
}): string | null => {
  const { manifest, expected, missingFiles, metadataChanged, stale } = args
  if (stale) {
    return `reference pack ${manifest.id} is for effect ${manifest.effectVersion}, expected ${expected.version}`
  }
  if (missingFiles.length > 0) {
    return `reference pack ${manifest.id} is missing ${missingFiles.length} file(s)`
  }
  if (metadataChanged) {
    return `reference pack ${manifest.id} metadata has changed on disk`
  }
  return null
}

export { PackManifest, PackStatus, PackVerification }
export type { Resolution } from "./Resolver.ts"
