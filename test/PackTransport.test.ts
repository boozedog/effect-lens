/**
 * Tests for the explicit pack artifact transport (`PackTransport`).
 *
 * These exercise the local-directory transport against temporary source
 * directories so no committed fixture is mutated and no network access is
 * required. They cover successful staging, a missing source, a non-directory
 * source, a missing source URL, and the injectable transport factory.
 *
 * @since 0.0.0
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackTransport from "../src/PackTransport.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const ID = "pack-effect-109"
const VERSION = "4.0.0-rc.109"
const INCLUDED = ["LLMS.md", "ai-docs/guide.md"]

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

const makeEntry = (args: { sourceUrl?: string | null } = {}): ReferencePack.PackManifest =>
  ReferencePack.makePackManifest({
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
    sourceUrl: args.sourceUrl === undefined ? "file:///nonexistent" : args.sourceUrl
  })

const tempSource = (): string => {
  const dir = track(mkdtempSync(join(tmpdir(), "el-src-")))
  mkdirSync(join(dir, "ai-docs"), { recursive: true })
  writeFileSync(join(dir, "LLMS.md"), "# Effect")
  writeFileSync(join(dir, "ai-docs", "guide.md"), "guide")
  return dir
}

describe("stageLocalDirectory", () => {
  it("stages a local directory artifact", () => {
    const source = tempSource()
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(existsSync(join(result.stagedDir, "LLMS.md"))).toBe(true)
      expect(existsSync(join(result.stagedDir, "ai-docs", "guide.md"))).toBe(true)
      rmSync(result.stagedDir, { recursive: true, force: true })
    }
  })

  it("accepts a plain filesystem path source URL", () => {
    const source = tempSource()
    const entry = makeEntry({ sourceUrl: source })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(true)
    if (result.ok) rmSync(result.stagedDir, { recursive: true, force: true })
  })

  it("refuses a missing source directory", () => {
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "does-not-exist")).href })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("source directory not found")
  })

  it("refuses a source that is not a directory", () => {
    const file = track(mkdtempSync(join(tmpdir(), "el-file-")))
    writeFileSync(join(file, "a.txt"), "x")
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(file, "a.txt")).href })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("not a directory")
  })

  it("refuses when the catalog entry has no source URL", () => {
    const entry = makeEntry({ sourceUrl: null })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("no source URL")
  })

  it("refuses a non-file URL scheme as unsupported", () => {
    const entry = makeEntry({ sourceUrl: "https://example.com/pack" })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("unsupported source URL")
  })

  it("does not mutate the source directory", () => {
    const source = tempSource()
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(true)
    expect(existsSync(join(source, "LLMS.md"))).toBe(true)
    if (result.ok) rmSync(result.stagedDir, { recursive: true, force: true })
  })

  it("preserves symlinks as symlinks so the executor traversal checks apply", () => {
    const source = tempSource()
    symlinkSync(join(source, "LLMS.md"), join(source, "link.md"))
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const result = PackTransport.stageLocalDirectory(entry)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(lstatSync(join(result.stagedDir, "link.md")).isSymbolicLink()).toBe(true)
      rmSync(result.stagedDir, { recursive: true, force: true })
    }
  })
})

describe("localDirectoryTransport", () => {
  it("returns an injectable transport that stages the artifact", () => {
    const source = tempSource()
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const transport = PackTransport.localDirectoryTransport()
    const result = transport(entry)
    expect(result.ok).toBe(true)
    if (result.ok) rmSync(result.stagedDir, { recursive: true, force: true })
  })

  it("surfaces a refusal without throwing", () => {
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "missing")).href })
    const transport = PackTransport.localDirectoryTransport()
    const result = transport(entry)
    expect(result.ok).toBe(false)
  })
})
