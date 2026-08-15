/**
 * Explicit pack artifact transport for reference-pack acquisition (issue #4,
 * third slice).
 *
 * This module provides the narrow, injectable transport that stages a pack
 * artifact for {@link PackAcquire.acquirePack}. It defines exactly ONE
 * supported artifact format for this slice: a local directory (the "source")
 * containing the pack's included files plus a decodable `manifest.json`. The
 * catalog entry's `sourceUrl` points at that directory, either as a `file://`
 * URL or as a plain filesystem path. The transport stages the directory into
 * a temporary location and returns it to the executor; it never mutates the
 * source and performs no network I/O.
 *
 * The transport is synchronous and matches the narrow
 * {@link PackAcquire.PackArtifactTransport} boundary exactly. It is only ever
 * invoked through an explicit call to {@link PackAcquire.acquirePack} — no
 * other command, plan, or operation gains implicit network or filesystem
 * behavior from this module. Failures are reported as short, non-secret
 * reasons; the transport never prints credentials, remote response bodies, or
 * arbitrary fetched content.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PackArtifactTransport, TransportFail, TransportOk } from "./PackAcquire.ts"
import type { PackManifest } from "./ReferencePack.ts"

/**
 * Resolves a catalog entry's `sourceUrl` to a local directory path, or `null`
 * when the URL is not a supported local source. A `file://` URL is converted
 * with `fileURLToPath`; a URL with any other scheme (for example `https://` or
 * `http://`) is unsupported and returns `null`; any other value is treated as
 * a plain filesystem path and resolved against the current working directory.
 *
 * @since 0.0.0
 */
const resolveSourceDir = (sourceUrl: string): string | null => {
  if (sourceUrl.startsWith("file://")) {
    try {
      return fileURLToPath(sourceUrl)
    } catch {
      return null
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(sourceUrl)) {
    return null
  }
  return resolve(process.cwd(), sourceUrl)
}

/**
 * Stages a local directory artifact for {@link PackAcquire.acquirePack}.
 *
 * The catalog entry's `sourceUrl` must point at a readable local directory.
 * The directory is copied into a fresh temporary directory (preserving
 * symlinks as symlinks so the executor's path-traversal/symlink checks still
 * apply) and returned as the staged artifact. The source is never mutated.
 *
 * @since 0.0.0
 */
export const stageLocalDirectory = (entry: PackManifest): TransportOk | TransportFail => {
  const sourceUrl = Option.getOrNull(entry.sourceUrl)
  if (sourceUrl === null) {
    return { ok: false, reason: "catalog entry has no source URL" }
  }
  const sourceDir = resolveSourceDir(sourceUrl)
  if (sourceDir === null) {
    return { ok: false, reason: `unsupported source URL: ${sourceUrl}` }
  }
  let stat
  try {
    stat = statSync(sourceDir)
  } catch {
    return { ok: false, reason: `source directory not found: ${sourceDir}` }
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `source is not a directory: ${sourceDir}` }
  }
  let stagingDir: string
  try {
    stagingDir = mkdtempSync(join(tmpdir(), "el-pack-source-"))
  } catch (err) {
    return { ok: false, reason: `cannot create staging directory: ${message(err)}` }
  }
  try {
    cpSync(sourceDir, stagingDir, { recursive: true })
  } catch (err) {
    rmrf(stagingDir)
    return { ok: false, reason: `cannot stage source directory: ${message(err)}` }
  }
  return { ok: true, stagedDir: stagingDir }
}

/**
 * Builds a {@link PackAcquire.PackArtifactTransport} that stages a local
 * directory artifact via {@link stageLocalDirectory}. The returned transport
 * is synchronous and injectable, so tests can exercise success and failure
 * without any live network.
 *
 * @since 0.0.0
 */
export const localDirectoryTransport = (): PackArtifactTransport => (entry) =>
  stageLocalDirectory(entry)

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const rmrf = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}
