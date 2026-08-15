/**
 * Explicit reference-pack acquisition with verification and atomic cache
 * promotion (issue #4, second slice).
 *
 * This module turns an explicit, exact catalog entry into a verified pack in
 * the local cache. Acquisition is NEVER implicit: a caller must pass an exact
 * {@link PackManifest} whose `sourceUrl` is present, plus an explicit
 * transport that materializes the pack's artifact into a local staging
 * directory. The executor owns all validation (manifest identity, included
 * paths, integrity, content completeness, path-traversal/symlink safety) and
 * the atomic promotion into the cache. It never invents a source URL, never
 * writes directly into the final pack directory, and never touches another
 * pack's directory.
 *
 * The transport boundary is narrow and synchronous: a
 * {@link PackArtifactTransport} receives the catalog entry and returns a local
 * directory (or a refusal) containing the fetched artifact. Real network
 * adapters stage the artifact to a temp directory before invoking
 * {@link acquirePack}; this module itself performs no network I/O and is fully
 * testable offline. It is invoked ONLY through an explicit call to
 * {@link acquirePack} — no other command, plan, or operation gains implicit
 * network behavior from this module.
 *
 * Promotion is atomic: the verified content is copied into an executor-owned
 * temporary directory under `cacheDir`, and that complete directory is then
 * renamed into `cacheDir/<packId>`. The final pack directory appears only via
 * that single rename, so a failed or refused acquisition never leaves a
 * partial pack. An existing complete pack is preserved by default; replacing a
 * divergent pack is an explicit opt-in (`replace: true`) implemented by moving
 * the old directory aside before the atomic rename and restoring it on failure.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Diagnostic } from "./Finding.ts"
import { samePackage } from "./PackageIdentity.ts"
import * as PackVerifier from "./PackVerifier.ts"
import { makePackManifest, PackManifest } from "./ReferencePack.ts"

/**
 * The outcome of an explicit {@link acquirePack} attempt.
 *
 * - `acquired` — the artifact was fetched, verified, and atomically promoted.
 * - `already-present` — an exact, complete pack is already cached; nothing was
 *   written and the transport was not invoked.
 * - `refused` — a deterministic precondition/validation failure (missing source
 *   URL, identity/version/integrity mismatch, missing file, traversal/symlink
 *   escape, or a divergent existing pack without an explicit replace). Nothing
 *   was written.
 * - `failed` — an unexpected transport or filesystem error prevented
 *   acquisition. Nothing was written to the final pack directory.
 *
 * @since 0.0.0
 */
export const AcquirePackAction = Schema.Literals([
  "acquired",
  "already-present",
  "refused",
  "failed"
])
export type AcquirePackAction = Schema.Schema.Type<typeof AcquirePackAction>

/**
 * The complete, Schema-backed result of an explicit acquisition attempt.
 *
 * `entry` is the exact catalog entry that was requested; `manifest` is the
 * promoted pack manifest when one exists (after `acquired`, or the existing
 * pack on `already-present`); `verification` is the detailed final check
 * against the cache when applicable; `diagnostics` drive exit policy and
 * `message` is a human-readable summary. Diagnostics NEVER contain credentials,
 * remote response bodies, or arbitrary fetched content.
 *
 * @since 0.0.0
 */
export class AcquirePackResult extends Schema.Class<AcquirePackResult>(
  "AcquirePackResult"
)({
  cacheDir: Schema.NonEmptyString,
  entry: PackManifest,
  action: AcquirePackAction,
  manifest: Schema.OptionFromNullOr(PackManifest),
  verification: Schema.OptionFromNullOr(PackVerifier.PackVerification),
  diagnostics: Schema.Array(Diagnostic),
  message: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs an {@link AcquirePackResult} value.
 *
 * @since 0.0.0
 */
export const makeAcquirePackResult = (args: {
  cacheDir: string
  entry: PackManifest
  action: AcquirePackAction
  manifest?: PackManifest | null
  verification?: PackVerifier.PackVerification | null
  diagnostics?: Array<Diagnostic>
  message?: string | null
}): AcquirePackResult =>
  new AcquirePackResult({
    cacheDir: args.cacheDir,
    entry: args.entry,
    action: args.action,
    manifest: Option.fromNullishOr(args.manifest),
    verification: Option.fromNullishOr(args.verification),
    diagnostics: args.diagnostics ?? [],
    message: Option.fromNullishOr(args.message)
  })

/**
 * A successful transport result: `stagedDir` is a local directory whose
 * contents are the fetched artifact, including a decodable `manifest.json`.
 * The transport owns the lifecycle of `stagedDir`; the executor copies out
 * exactly the validated included files and writes its own manifest.
 *
 * @since 0.0.0
 */
export type TransportOk = { ok: true; stagedDir: string }

/**
 * A refused transport result. `reason` is a short, non-secret description that
 * the executor surfaces as a `failed` diagnostic.
 *
 * @since 0.0.0
 */
export type TransportFail = { ok: false; reason: string }

/**
 * The narrow acquisition transport boundary.
 *
 * A transport receives the explicit catalog entry (the ONLY source of the
 * artifact's URL) and returns either a local staged directory or a refusal. It
 * is synchronous by design: real network adapters stage the artifact to a temp
 * directory before invoking {@link acquirePack}. The executor never calls a
 * transport implicitly and performs no network I/O itself.
 *
 * @since 0.0.0
 */
export type PackArtifactTransport = (
  entry: PackManifest
) => TransportOk | TransportFail

/**
 * True when a staged path `candidate` resolves to a location strictly inside
 * the staged root `root` (a single path segment or a nested path, never a
 * parent escape and never absolute).
 *
 * @since 0.0.0
 */
export const isWithinStaged = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}

/**
 * Acquires an explicit, exact catalog entry into `cacheDir`, verifying the
 * staged artifact and atomically promoting it only after every check passes.
 *
 * Steps:
 * 1. Refuse when the catalog entry has no explicit `sourceUrl`.
 * 2. Preserve an existing complete pack (`already-present`, transport not
 *    invoked). Refuse a divergent existing pack unless `replace: true`.
 * 3. Invoke the injected transport to obtain a staged artifact.
 * 4. Validate the staged manifest (decodes, id matches, exact package
 *    name+version match, included paths match the catalog).
 * 5. Check every included path stays within the staged root, is a regular
 *    non-symlink file, and is present (content completeness).
 * 6. Verify SRI integrity when the catalog entry provides it.
 * 7. Copy the validated files plus a final manifest into an executor-owned
 *    temp directory under `cacheDir`, then atomically promote it into
 *    `cacheDir/<packId>` (moving any divergent pack aside first only in
 *    `replace` mode, and restoring it on failure).
 *
 * A refused or failed attempt never writes into the final pack directory.
 *
 * @since 0.0.0
 */
export const acquirePack = (args: {
  cacheDir: string
  catalogEntry: PackManifest
  transport: PackArtifactTransport
  replace?: boolean
}): AcquirePackResult => {
  const { cacheDir, catalogEntry, transport } = args
  const replace = args.replace ?? false
  const expected = catalogEntry.packageIdentity
  // 0. The pack id is the write target directory name. It must be a single,
  //    safe path segment so `cacheDir/<id>` can never escape the cache.
  if (!isSafePackId(catalogEntry.id)) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-invalid-pack-id",
      message: `catalog entry id ${catalogEntry.id} is not a safe single path segment`
    })
  }
  const finalDir = join(cacheDir, catalogEntry.id)
  // 1. Explicit source is required; the executor never invents one.
  if (Option.isNone(catalogEntry.sourceUrl)) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-missing-source",
      message: `catalog entry ${catalogEntry.id} has no explicit source URL`
    })
  }
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (err) {
    return failedFor(cacheDir, catalogEntry, "acq-cache-unavailable", err)
  }
  // 2. Existing pack handling. An exact, complete pack is preserved as a
  //    no-op; a divergent pack is refused unless an explicit replace is
  //    requested. Both paths avoid invoking the transport.
  const existing = PackVerifier.verifyPack({ manifest: catalogEntry, expected, cacheDir })
  // A pack is only "complete" when its stored manifest is decodable AND matches
  // the catalog (metadataChanged false), every included file is present, and it
  // is not stale. A missing or corrupt manifest.json is therefore NOT complete:
  // it is a divergent pack that `replace: true` can recover.
  const storedManifest = readDirManifest(finalDir)
  const complete = storedManifest !== null && existing.missingFiles.length === 0 &&
    !existing.metadataChanged && !existing.stale
  if (existsSync(finalDir)) {
    if (complete) {
      const stored = PackVerifier.findPack(cacheDir, expected) ?? catalogEntry
      return makeAcquirePackResult({
        cacheDir,
        entry: catalogEntry,
        action: "already-present",
        manifest: stored,
        verification: existing,
        message: `reference pack ${catalogEntry.id} is already complete`
      })
    }
    if (!replace) {
      return refused({
        cacheDir,
        entry: catalogEntry,
        id: "acq-existing-divergent",
        message: Option.getOrNull(existing.message) ??
          `cached pack ${catalogEntry.id} diverges from the catalog and replace is not set`
      })
    }
  }
  // 3. Transport boundary.
  let staged: TransportOk | TransportFail
  try {
    staged = transport(catalogEntry)
  } catch (err) {
    return failedFor(cacheDir, catalogEntry, "acq-transport-failed", err)
  }
  if (!staged.ok) {
    return makeAcquirePackResult({
      cacheDir,
      entry: catalogEntry,
      action: "failed",
      diagnostics: [diag("acq-transport-failed", staged.reason)],
      message: `transport failed for ${catalogEntry.id}: ${staged.reason}`
    })
  }
  const stagedDir = staged.stagedDir
  // 4. Staged manifest identity.
  const stagedManifest = readDirManifest(stagedDir)
  if (stagedManifest === null) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-invalid-staged-manifest",
      message: `staged artifact for ${catalogEntry.id} has no valid manifest.json`
    })
  }
  if (stagedManifest.id !== catalogEntry.id) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-identity-mismatch",
      message: `staged manifest id ${stagedManifest.id} does not match ${catalogEntry.id}`
    })
  }
  if (!samePackage(stagedManifest.packageIdentity, expected)) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-version-mismatch",
      message: `staged manifest for ${catalogEntry.id} does not match exact package ` +
        `${expected.name}@${expected.version}`
    })
  }
  if (!arraysEqual(stagedManifest.includedPaths, catalogEntry.includedPaths)) {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-paths-mismatch",
      message: `staged manifest included paths do not match catalog for ${catalogEntry.id}`
    })
  }
  // 5. Path safety + content completeness.
  //    A lexically-contained resolved path plus a realpath containment check
  //    together reject `..`/absolute escapes AND symlinked ancestor directories
  //    that point outside the staged root. Every included leaf must be a
  //    regular non-symlink file that is actually present.
  let realRoot: string
  try {
    realRoot = realpathSync(stagedDir)
  } catch {
    return refused({
      cacheDir,
      entry: catalogEntry,
      id: "acq-invalid-staged-artifact",
      message: `staged artifact directory for ${catalogEntry.id} is not accessible`
    })
  }
  const files: Array<string> = []
  for (const p of catalogEntry.includedPaths) {
    const resolved = resolve(stagedDir, p)
    if (!isWithinStaged(stagedDir, resolved)) {
      return refused({
        cacheDir,
        entry: catalogEntry,
        id: "acq-path-traversal",
        message: `included path escapes the staged artifact: ${p}`
      })
    }
    let stat
    try {
      stat = lstatSync(resolved)
    } catch {
      return refused({
        cacheDir,
        entry: catalogEntry,
        id: "acq-missing-file",
        message: `included file is missing from staged artifact: ${p}`
      })
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return refused({
        cacheDir,
        entry: catalogEntry,
        id: "acq-path-traversal",
        message: `included path is not a regular file: ${p}`
      })
    }
    if (!isWithinStaged(realRoot, realpathSync(resolved))) {
      return refused({
        cacheDir,
        entry: catalogEntry,
        id: "acq-path-traversal",
        message: `included path escapes the staged artifact via a symlink: ${p}`
      })
    }
    files.push(p)
  }
  // 6. Integrity when provided.
  const integrity = checkIntegrity(catalogEntry.integrity, stagedDir, catalogEntry.includedPaths)
  if (!integrity.ok) {
    const id = integrity.reason === "unsupported"
      ? "acq-integrity-unsupported"
      : "acq-integrity-mismatch"
    return refused({
      cacheDir,
      entry: catalogEntry,
      id,
      message: integrity.message
    })
  }
  // 7. Stage the verified content + final manifest into an executor-owned temp
  //    directory, then promote atomically. The final manifest preserves the
  //    catalog's upstream ref, source URL, integrity, included paths, and
  //    attribution.
  const finalManifest = buildFinalManifest(catalogEntry)
  let stagingDir: string
  try {
    stagingDir = mkdtempSync(join(cacheDir, `.acquire-${sanitize(catalogEntry.id)}-`))
  } catch (err) {
    return failedFor(cacheDir, catalogEntry, "acq-stage-failed", err)
  }
  try {
    for (const p of files) {
      const dst = join(stagingDir, p)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(join(stagedDir, p), dst)
    }
    writeFileSync(
      join(stagingDir, "manifest.json"),
      JSON.stringify(Schema.encodeSync(PackManifest)(finalManifest), null, 2)
    )
  } catch (err) {
    rmrf(stagingDir)
    return failedFor(cacheDir, catalogEntry, "acq-stage-failed", err)
  }
  const promoted = promoteDir(stagingDir, finalDir, replace)
  if (!promoted.ok) {
    rmrf(stagingDir)
    return makeAcquirePackResult({
      cacheDir,
      entry: catalogEntry,
      action: "failed",
      diagnostics: [diag("acq-promote-failed", promoted.reason)],
      message: `could not promote ${catalogEntry.id}: ${promoted.reason}`
    })
  }
  const finalVerification = PackVerifier.verifyPack({ manifest: finalManifest, expected, cacheDir })
  return makeAcquirePackResult({
    cacheDir,
    entry: catalogEntry,
    action: "acquired",
    manifest: finalManifest,
    verification: finalVerification,
    message: `acquired reference pack ${catalogEntry.id}`
  })
}

/**
 * Builds a `refused` {@link AcquirePackResult} with a single error diagnostic.
 *
 * @internal
 */
const refused = (args: {
  cacheDir: string
  entry: PackManifest
  id: string
  message: string
}): AcquirePackResult =>
  makeAcquirePackResult({
    cacheDir: args.cacheDir,
    entry: args.entry,
    action: "refused",
    diagnostics: [diag(args.id, args.message)],
    message: args.message
  })

/**
 * Builds a `failed` {@link AcquirePackResult} from a thrown filesystem error.
 *
 * @internal
 */
const failedFor = (
  cacheDir: string,
  entry: PackManifest,
  id: string,
  err: unknown
): AcquirePackResult => {
  const reason = err instanceof Error ? err.message : String(err)
  return makeAcquirePackResult({
    cacheDir,
    entry,
    action: "failed",
    diagnostics: [diag(id, reason)],
    message: reason
  })
}

const diag = (id: string, message: string): Diagnostic =>
  new Diagnostic({ id, severity: "error", message, location: Option.none() })

/**
 * Reads and decodes a directory's `manifest.json` (a staged artifact or a
 * cached pack), or `null` when it is missing or undecodable.
 *
 * @internal
 */
const readDirManifest = (dir: string): PackManifest | null => {
  const path = join(dir, "manifest.json")
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

/**
 * Builds the final promoted manifest from the catalog entry, preserving its
 * upstream ref, source URL, integrity, included paths, and attribution, and
 * marking the pack `complete`.
 *
 * @internal
 */
const buildFinalManifest = (entry: PackManifest): PackManifest =>
  makePackManifest({
    id: entry.id,
    effectVersion: entry.effectVersion,
    packageIdentity: entry.packageIdentity,
    upstream: entry.upstream,
    includedPaths: [...entry.includedPaths],
    status: "complete",
    sourceUrl: Option.getOrNull(entry.sourceUrl),
    integrity: Option.getOrNull(entry.integrity),
    attribution: Option.getOrNull(entry.attribution)
  })

/**
 * Verifies the SRI integrity of the staged included files against the catalog
 * entry's integrity string. When no integrity is declared the check passes
 * trivially.
 *
 * The hash input is framed per file so that independently consumed files cannot
 * be re-sliced into a collision: for each path in catalog order the bytes
 * `path \0 uint64le(len) \0 <file bytes>` are fed to the hash. Only the SRI
 * `sha256` and `sha512` algorithms are accepted; anything else is refused as
 * unsupported.
 *
 * @internal
 */
const checkIntegrity = (
  integrity: Option.Option<string>,
  stagedDir: string,
  includedPaths: readonly string[]
): { ok: true } | { ok: false; reason: "mismatch" | "unsupported"; message: string } => {
  if (Option.isNone(integrity)) return { ok: true }
  const spec = Option.getOrNull(integrity) as string
  const dash = spec.indexOf("-")
  if (dash <= 0) {
    return { ok: false, reason: "unsupported", message: "malformed integrity spec" }
  }
  const algorithm = spec.slice(0, dash)
  const expected = spec.slice(dash + 1)
  if (algorithm !== "sha256" && algorithm !== "sha512") {
    return {
      ok: false,
      reason: "unsupported",
      message: `unsupported integrity algorithm: ${algorithm}`
    }
  }
  let hash
  try {
    hash = createHash(algorithm)
  } catch {
    return {
      ok: false,
      reason: "unsupported",
      message: `unsupported integrity algorithm: ${algorithm}`
    }
  }
  for (const p of includedPaths) {
    const data = readFileSync(join(stagedDir, p))
    hash.update(frame(p, data))
  }
  const actual = hash.digest("base64")
  if (actual !== expected) {
    return {
      ok: false,
      reason: "mismatch",
      message: `integrity mismatch for ${includedPaths.length} file(s)`
    }
  }
  return { ok: true }
}

/**
 * Atomically promotes a fully-populated staging directory into `finalDir`.
 *
 * When `finalDir` is absent this is a single atomic `rename`. When it exists
 * and `replace` is set, the existing directory is first moved aside and then
 * restored if the promotion rename fails, so a divergent pack is never left
 * half-removed. Without `replace`, an existing `finalDir` is a refusal.
 *
 * @internal
 */
const promoteDir = (
  stagingDir: string,
  finalDir: string,
  replace: boolean
): { ok: true } | { ok: false; reason: string } => {
  if (!existsSync(finalDir)) {
    try {
      renameSync(stagingDir, finalDir)
      return { ok: true }
    } catch {
      return { ok: false, reason: `cannot promote into ${finalDir}` }
    }
  }
  if (!replace) return { ok: false, reason: `target already exists: ${finalDir}` }
  const backup = `${finalDir}.acquire-old-${suffix()}`
  try {
    renameSync(finalDir, backup)
  } catch {
    return { ok: false, reason: `cannot move existing pack aside: ${finalDir}` }
  }
  try {
    renameSync(stagingDir, finalDir)
  } catch {
    try {
      renameSync(backup, finalDir)
    } catch {
      // Best effort restore; the backup path is still reported via cleanup.
    }
    return { ok: false, reason: `cannot promote staged pack into ${finalDir}` }
  }
  try {
    rmSync(backup, { recursive: true, force: true })
  } catch {
    // Leftover backup is harmless and best-effort removed.
  }
  return { ok: true }
}

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Frames one file for integrity hashing as `path \0 uint64le(len) \0 bytes`, so
 * the concatenation cannot be re-sliced across files into a collision.
 *
 * @internal
 */
const frame = (path: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(data.length))
  return Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0]), len, Buffer.from([0]), data])
}

/**
 * True when a pack id is a single safe path segment: non-empty, not `.`/`..`,
 * and free of separators or absolute-path escapes.
 *
 * @internal
 */
const isSafePackId = (id: string): boolean =>
  id.length > 0 && id !== "." && id !== ".." && !isAbsolute(id) && !id.includes("/") &&
  !id.includes("\\")

const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "-")

const rmrf = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}

const suffix = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export { PackManifest, PackVerifier }
export type { PackageIdentity } from "./PackageIdentity.ts"
