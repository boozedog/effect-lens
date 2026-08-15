/**
 * Tests for the explicit reference-pack acquisition executor
 * (`PackAcquire.acquirePack`).
 *
 * These exercise the full pipeline against temporary cache and staging
 * directories so no committed fixture is ever mutated and no network access is
 * required: the injected transport returns a locally-staged artifact. They
 * cover successful atomic promotion, the already-present no-op, every refused
 * precondition (missing source, version mismatch, integrity mismatch, missing
 * file, path traversal, symlink escape), a failed transport, and the
 * no-partial-write guarantee (a refused/failed attempt leaves no pack and no
 * staging leftovers).
 *
 * @since 0.0.0
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as PackAcquire from "../src/PackAcquire.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const ID = "pack-effect-109"
const VERSION = "4.0.0-rc.109"
const SOURCE_URL = "https://github.com/effect-ts/effect"
const INCLUDED = ["LLMS.md", "ai-docs/guide.md"]

// Every temp directory created by the helpers below is registered here and
// removed after each test, so no `el-stage-*` / `el-cache-*` dirs leak.
const trackedDirs: Array<string> = []
const track = (dir: string): string => {
  trackedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true })
  trackedDirs.length = 0
})

const upstream = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "deadbeef"
})

/**
 * Builds a catalog {@link PackManifest}. Defaults to the exact pack used across
 * the suite; `sourceUrl`/`integrity` default to present/absent unless overridden
 * (pass `null` to clear them).
 *
 * @since 0.0.0
 */
const makeEntry = (args: {
  id?: string
  version?: string
  integrity?: string | null
  sourceUrl?: string | null
} = {}): ReferencePack.PackManifest =>
  ReferencePack.makePackManifest({
    id: args.id ?? ID,
    effectVersion: args.version ?? VERSION,
    packageIdentity: PackageIdentity.makePackageIdentity({
      name: "effect",
      version: args.version ?? VERSION,
      source: "lockfile"
    }),
    upstream,
    includedPaths: [...INCLUDED],
    status: "complete",
    sourceUrl: args.sourceUrl === undefined ? SOURCE_URL : args.sourceUrl,
    integrity: args.integrity === undefined ? null : args.integrity
  })

/**
 * Writes a manifest as the staged artifact's `manifest.json`.
 *
 * @since 0.0.0
 */
const writeManifest = (dir: string, manifest: ReferencePack.PackManifest): void => {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(Schema.encodeSync(ReferencePack.PackManifest)(manifest))
  )
}

/**
 * Creates a temporary staged artifact directory populated with the given files
 * and manifest.
 *
 * @since 0.0.0
 */
const stageArtifact = (args: {
  manifest: ReferencePack.PackManifest
  files: Record<string, string>
}): string => {
  const dir = track(mkdtempSync(join(tmpdir(), "el-stage-")))
  for (const [path, content] of Object.entries(args.files)) {
    const p = join(dir, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  writeManifest(dir, args.manifest)
  return dir
}

/**
 * Frames one file for integrity hashing exactly as the executor does
 * (`path \0 uint64le(len) \0 bytes`).
 *
 * @since 0.0.0
 */
const frame = (path: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(data.length))
  return Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0]), len, Buffer.from([0]), data])
}

/**
 * Computes the `sha512-` SRI over the framed bytes of the given files, the
 * integrity convention the executor verifies.
 *
 * @since 0.0.0
 */
const integrityOf = (dir: string, paths: readonly string[]): string => {
  const hash = createHash("sha512")
  for (const p of paths) hash.update(frame(p, readFileSync(join(dir, p))))
  return `sha512-${hash.digest("base64")}`
}

const transportFor = (stagedDir: string): PackAcquire.PackArtifactTransport => () => ({
  ok: true,
  stagedDir
})

const tempCache = (): string => track(mkdtempSync(join(tmpdir(), "el-cache-")))

describe("acquirePack", () => {
  it("acquires, verifies, and atomically promotes an exact pack", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("acquired")
      expect(Option.getOrNull(result.manifest)?.id).toBe(ID)
      expect(Option.getOrNull(result.manifest)?.status).toBe("complete")
      // Final files + manifest present in the cache pack directory.
      expect(existsSync(join(cacheDir, ID, "manifest.json"))).toBe(true)
      expect(existsSync(join(cacheDir, ID, "LLMS.md"))).toBe(true)
      expect(existsSync(join(cacheDir, ID, "ai-docs", "guide.md"))).toBe(true)
      // Final verification reports a complete, intact pack.
      const verification = Option.getOrNull(result.verification)
      expect(verification?.missingFiles).toEqual([])
      expect(verification?.metadataChanged).toBe(false)
      expect(verification?.stale).toBe(false)
      // No staging leftovers.
      expect(readdirSync(cacheDir).some((n) => n.startsWith(".acquire-"))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("preserves the catalog's upstream, source, integrity, paths, and attribution", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const attribution = new Provenance.Attribution({
        license: Option.none(),
        copyright: Option.none(),
        notice: Option.some("MIT (c) effect-ts")
      })
      const entry = ReferencePack.makePackManifest({
        id: ID,
        effectVersion: VERSION,
        packageIdentity: PackageIdentity.makePackageIdentity({
          name: "effect",
          version: VERSION,
          source: "lockfile"
        }),
        upstream,
        includedPaths: [...INCLUDED],
        status: "complete",
        sourceUrl: SOURCE_URL,
        integrity: integrityOf(staged, INCLUDED),
        attribution
      })
      PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
      const stored = readFileSync(join(cacheDir, ID, "manifest.json"), "utf8")
      const decoded = Option.getOrNull(
        Schema.decodeUnknownOption(ReferencePack.PackManifest)(JSON.parse(stored))
      )
      expect(decoded?.id).toBe(ID)
      expect(Option.getOrNull(decoded?.sourceUrl ?? Option.none())).toBe(SOURCE_URL)
      expect(Option.getOrNull(decoded?.integrity ?? Option.none())).toBe(
        integrityOf(staged, INCLUDED)
      )
      expect(decoded?.includedPaths).toEqual(INCLUDED)
      expect(Option.getOrNull(decoded?.upstream.commit ?? Option.none())).toBe("deadbeef")
      expect(Option.getOrNull(decoded?.attribution ?? Option.none())?.notice)
        .toEqual(Option.some("MIT (c) effect-ts"))
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("returns already-present for an existing complete pack without invoking the transport", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      expect(
        PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
          .action
      ).toBe("acquired")
      let calls = 0
      const spy: PackAcquire.PackArtifactTransport = () => {
        calls += 1
        return { ok: false, reason: "must not be called" }
      }
      const result = PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: spy })
      expect(result.action).toBe("already-present")
      expect(calls).toBe(0)
      expect(Option.getOrNull(result.manifest)?.id).toBe(ID)
      expect(result.diagnostics).toEqual([])
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses when the catalog entry has no explicit source URL", () => {
    const cacheDir = tempCache()
    try {
      const entry = makeEntry({ sourceUrl: null })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: () => ({ ok: false, reason: "must not be called" })
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-missing-source")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses on a staged version mismatch", () => {
    const cacheDir = tempCache()
    try {
      // The staged manifest declares a different exact version than the catalog.
      const staged = stageArtifact({
        manifest: makeEntry({ id: ID, version: "4.0.0-rc.100" }),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: makeEntry(),
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-version-mismatch")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses on an integrity mismatch", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-integrity-mismatch")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses an integrity algorithm outside the sha256/sha512 allowlist", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: "md5-deadbeef" })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-integrity-unsupported")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses when an included file is missing from the staged artifact", () => {
    const cacheDir = tempCache()
    try {
      // Catalog and staged manifest agree on the paths, but the staged dir is
      // missing one of the files.
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect" }
      })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: makeEntry(),
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-missing-file")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses on a path-traversal included path", () => {
    const cacheDir = tempCache()
    try {
      // The staged manifest and catalog agree on a path that escapes the
      // staged root; the executor must reject it before reading any content.
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = ReferencePack.makePackManifest({
        id: ID,
        effectVersion: VERSION,
        packageIdentity: PackageIdentity.makePackageIdentity({
          name: "effect",
          version: VERSION,
          source: "lockfile"
        }),
        upstream,
        includedPaths: ["LLMS.md", "../secret.md"],
        status: "complete",
        sourceUrl: SOURCE_URL
      })
      writeManifest(staged, entry)
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-path-traversal")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses on a symlink escape through a staged ancestor directory", () => {
    const cacheDir = tempCache()
    try {
      // `ai-docs` is a symlink to an OUTSIDE directory. The leaf resolves to a
      // real regular file, but its realpath escapes the staged root, so the
      // executor must refuse rather than copy outside content.
      const outside = track(mkdtempSync(join(tmpdir(), "el-outside-")))
      writeFileSync(join(outside, "guide.md"), "outside secret")
      const staged = track(mkdtempSync(join(tmpdir(), "el-stage-")))
      writeFileSync(join(staged, "LLMS.md"), "# Effect")
      symlinkSync(outside, join(staged, "ai-docs"))
      writeManifest(staged, makeEntry())
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: makeEntry(),
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-path-traversal")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
      rmSync(outside, { recursive: true, force: true })
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("reports failed when the transport refuses", () => {
    const cacheDir = tempCache()
    try {
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: makeEntry(),
        transport: () => ({ ok: false, reason: "network unavailable" })
      })
      expect(result.action).toBe("failed")
      expect(result.diagnostics[0]?.id).toBe("acq-transport-failed")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("leaves no partial pack or staging leftovers on a refused acquisition", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      const names = readdirSync(cacheDir)
      expect(names.some((n) => n === ID)).toBe(false)
      expect(names.some((n) => n.startsWith(".acquire-"))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("preserves a divergent existing pack and refuses replacement by default", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      // First acquisition succeeds with the original content.
      expect(
        PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
          .action
      ).toBe("acquired")
      // A cached file is deleted, making the pack diverge from the catalog.
      rmSync(join(cacheDir, ID, "ai-docs", "guide.md"))
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-existing-divergent")
      // The divergent pack is left untouched (still missing the file).
      expect(existsSync(join(cacheDir, ID, "ai-docs", "guide.md"))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("replaces a divergent pack only with replace: true", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      expect(
        PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
          .action
      ).toBe("acquired")
      // Delete a cached file so the pack diverges from the catalog.
      rmSync(join(cacheDir, ID, "ai-docs", "guide.md"))
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged),
        replace: true
      })
      expect(result.action).toBe("acquired")
      expect(readFileSync(join(cacheDir, ID, "LLMS.md"), "utf8")).toBe("# Effect")
      expect(existsSync(join(cacheDir, ID, "ai-docs", "guide.md"))).toBe(true)
      // No leftover backup or staging directories.
      const names = readdirSync(cacheDir)
      expect(names.some((n) => n.startsWith(".acquire-"))).toBe(false)
      expect(names.some((n) => n.includes("acquire-old"))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("does not report already-present when the stored manifest is missing", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      // A complete pack exists, then its manifest.json is removed (files remain).
      expect(
        PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
          .action
      ).toBe("acquired")
      rmSync(join(cacheDir, ID, "manifest.json"))
      let calls = 0
      const spy: PackAcquire.PackArtifactTransport = () => {
        calls += 1
        return { ok: false, reason: "must not be called" }
      }
      const result = PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: spy })
      // Without a stored manifest the pack is divergent, not complete: refused
      // and the transport is NOT invoked (no pointless refetch).
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-existing-divergent")
      expect(calls).toBe(0)
      // replace: true recovers by promoting a fresh complete pack.
      const replaced = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged),
        replace: true
      })
      expect(replaced.action).toBe("acquired")
      expect(existsSync(join(cacheDir, ID, "manifest.json"))).toBe(true)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("does not report already-present when the stored manifest is corrupt", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = makeEntry({ integrity: integrityOf(staged, INCLUDED) })
      expect(
        PackAcquire.acquirePack({ cacheDir, catalogEntry: entry, transport: transportFor(staged) })
          .action
      ).toBe("acquired")
      writeFileSync(join(cacheDir, ID, "manifest.json"), "{not json")
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-existing-divergent")
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses an unsafe (escaping) pack id before any write", () => {
    const cacheDir = tempCache()
    try {
      const staged = stageArtifact({
        manifest: makeEntry(),
        files: { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
      })
      const entry = ReferencePack.makePackManifest({
        id: "../escaped-pack",
        effectVersion: VERSION,
        packageIdentity: PackageIdentity.makePackageIdentity({
          name: "effect",
          version: VERSION,
          source: "lockfile"
        }),
        upstream,
        includedPaths: [...INCLUDED],
        status: "complete",
        sourceUrl: SOURCE_URL
      })
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(staged)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-invalid-pack-id")
      // Nothing was written outside the cache.
      expect(existsSync(join(cacheDir, "..", "escaped-pack"))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("refuses when re-slicing file boundaries changes content under a fixed hash", () => {
    const cacheDir = tempCache()
    try {
      // Catalog pins the framed hash of the split "ab" + "cd" files.
      const pinned = stageArtifact({
        manifest: ReferencePack.makePackManifest({
          id: ID,
          effectVersion: VERSION,
          packageIdentity: PackageIdentity.makePackageIdentity({
            name: "effect",
            version: VERSION,
            source: "lockfile"
          }),
          upstream,
          includedPaths: ["a.txt", "b.txt"],
          status: "complete",
          sourceUrl: SOURCE_URL
        }),
        files: { "a.txt": "ab", "b.txt": "cd" }
      })
      const entry = ReferencePack.makePackManifest({
        id: ID,
        effectVersion: VERSION,
        packageIdentity: PackageIdentity.makePackageIdentity({
          name: "effect",
          version: VERSION,
          source: "lockfile"
        }),
        upstream,
        includedPaths: ["a.txt", "b.txt"],
        status: "complete",
        sourceUrl: SOURCE_URL,
        integrity: integrityOf(pinned, ["a.txt", "b.txt"])
      })
      // A different artifact whose RAW concatenation ("abcd") is identical, but
      // whose per-file framing differs, must be refused as an integrity mismatch.
      const resliced = stageArtifact({
        manifest: makeEntry(),
        files: { "a.txt": "a", "b.txt": "bcd" }
      })
      writeManifest(
        resliced,
        ReferencePack.makePackManifest({
          id: ID,
          effectVersion: VERSION,
          packageIdentity: PackageIdentity.makePackageIdentity({
            name: "effect",
            version: VERSION,
            source: "lockfile"
          }),
          upstream,
          includedPaths: ["a.txt", "b.txt"],
          status: "complete",
          sourceUrl: SOURCE_URL
        })
      )
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: entry,
        transport: transportFor(resliced)
      })
      expect(result.action).toBe("refused")
      expect(result.diagnostics[0]?.id).toBe("acq-integrity-mismatch")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it("reports failed when the transport throws", () => {
    const cacheDir = tempCache()
    try {
      const result = PackAcquire.acquirePack({
        cacheDir,
        catalogEntry: makeEntry(),
        transport: () => {
          throw new Error("boom")
        }
      })
      expect(result.action).toBe("failed")
      expect(result.diagnostics[0]?.id).toBe("acq-transport-failed")
      expect(existsSync(join(cacheDir, ID))).toBe(false)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
