/**
 * Tests for the `effect-lens packs plan` and `effect-lens packs fetch` CLI
 * commands.
 *
 * These exercise the CLI adapters against temporary catalog, source, and
 * cache directories so no committed fixture is mutated and no network access
 * is required: the local-directory transport stages a temp source directory.
 * They cover a successful fetch, a missing source, a transport failure, a
 * malformed artifact, an exact-version mismatch, an integrity failure, the
 * already-present no-op, a missing catalog entry, and the guarantee that
 * `doctor`/`drift` never fetch implicitly.
 *
 * @since 0.0.0
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { doctor } from "../src/cli/commands/doctor.ts"
import { drift } from "../src/cli/commands/drift.ts"
import { packsFetch, packsPlan, packsStatus } from "../src/cli/commands/packs.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const ID = "pack-effect-109"
const VERSION = "4.0.0-rc.109"
const INCLUDED = ["LLMS.md", "ai-docs/guide.md"]

const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))

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

const makeEntry = (args: {
  id?: string
  version?: string
  sourceUrl?: string | null
  integrity?: string | null
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
    sourceUrl: args.sourceUrl === undefined ? null : args.sourceUrl,
    integrity: args.integrity === undefined ? null : args.integrity
  })

const writeManifest = (dir: string, manifest: ReferencePack.PackManifest): void => {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(Schema.encodeSync(ReferencePack.PackManifest)(manifest))
  )
}

const tempCache = (): string => track(mkdtempSync(join(tmpdir(), "el-cache-")))

const tempCatalog = (entry: ReferencePack.PackManifest): string => {
  const dir = track(mkdtempSync(join(tmpdir(), "el-catalog-")))
  mkdirSync(join(dir, entry.id), { recursive: true })
  writeManifest(join(dir, entry.id), entry)
  return dir
}

const tempSource = (
  manifest: ReferencePack.PackManifest,
  files: Record<string, string>
): string => {
  const dir = track(mkdtempSync(join(tmpdir(), "el-src-")))
  for (const [path, content] of Object.entries(files)) {
    const p = join(dir, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  writeManifest(dir, manifest)
  return dir
}

describe("packs plan", () => {
  it("returns a read-only plan without mutating the cache", () => {
    const cacheDir = tempCache()
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "missing")).href })
    const catalogDir = tempCatalog(entry)
    const result = packsPlan({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as { plan: { action: string } }
    expect(json.plan.action).toBe("fetch-required")
    expect(readdirSync(cacheDir)).toEqual([])
  })
})

describe("packs fetch", () => {
  it("fetches, verifies, and promotes an exact pack", () => {
    const cacheDir = tempCache()
    const source = tempSource(makeEntry(), { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" })
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as { acquire: { action: string } }
    expect(json.acquire.action).toBe("acquired")
    expect(existsSync(join(cacheDir, ID, "manifest.json"))).toBe(true)
    expect(existsSync(join(cacheDir, ID, "LLMS.md"))).toBe(true)
  })

  it("reports failed when the source directory is missing", () => {
    const cacheDir = tempCache()
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "does-not-exist")).href })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(2)
    const json = result.json as { acquire: { action: string } }
    expect(json.acquire.action).toBe("failed")
    expect(existsSync(join(cacheDir, ID))).toBe(false)
  })

  it("refuses a malformed staged artifact", () => {
    const cacheDir = tempCache()
    const source = tempSource(makeEntry(), { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" })
    writeFileSync(join(source, "manifest.json"), "{not json")
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(2)
    const json = result.json as { acquire: { action: string } }
    expect(json.acquire.action).toBe("refused")
    expect(existsSync(join(cacheDir, ID))).toBe(false)
  })

  it("refuses an exact-version mismatch before any cache mutation", () => {
    const cacheDir = tempCache()
    const source = tempSource(
      makeEntry({ version: "4.0.0-rc.100" }),
      { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" }
    )
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(2)
    const json = result.json as { acquire: { action: string; diagnostics: Array<{ id: string }> } }
    expect(json.acquire.action).toBe("refused")
    expect(json.acquire.diagnostics[0].id).toBe("acq-version-mismatch")
    expect(existsSync(join(cacheDir, ID))).toBe(false)
  })

  it("refuses an integrity failure before any cache mutation", () => {
    const cacheDir = tempCache()
    const source = tempSource(makeEntry(), { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" })
    const entry = makeEntry({
      sourceUrl: pathToFileURL(source).href,
      integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(2)
    const json = result.json as { acquire: { action: string; diagnostics: Array<{ id: string }> } }
    expect(json.acquire.action).toBe("refused")
    expect(json.acquire.diagnostics[0].id).toBe("acq-integrity-mismatch")
    expect(existsSync(join(cacheDir, ID))).toBe(false)
  })

  it("is a safe no-op for an existing complete pack", () => {
    const cacheDir = tempCache()
    const source = tempSource(makeEntry(), { "LLMS.md": "# Effect", "ai-docs/guide.md": "guide" })
    const entry = makeEntry({ sourceUrl: pathToFileURL(source).href })
    const catalogDir = tempCatalog(entry)
    expect(
      packsFetch({ projectDir: project("pnpm-valid"), cacheDir, catalogDir, packId: ID })
        .machineOutput.status
    ).toBe(0)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: ID
    })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as { acquire: { action: string } }
    expect(json.acquire.action).toBe("already-present")
  })

  it("errors when the catalog entry is missing", () => {
    const cacheDir = tempCache()
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "missing")).href })
    const catalogDir = tempCatalog(entry)
    const result = packsFetch({
      projectDir: project("pnpm-valid"),
      cacheDir,
      catalogDir,
      packId: "nope"
    })
    expect(result.machineOutput.status).toBe(2)
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "packs-entry-missing")
    ).toBe(true)
    expect(existsSync(join(cacheDir, "nope"))).toBe(false)
  })
})

describe("no implicit fetch", () => {
  it("doctor and drift never fetch into an empty cache", () => {
    const cacheDir = tempCache()
    const doctorResult = doctor({ projectDir: project("pnpm-valid"), cacheDir })
    const driftResult = drift({ projectDir: project("pnpm-valid"), cacheDir })
    // Both report the missing pack without creating one.
    expect(doctorResult.machineOutput.diagnostics.some((d) => d.id === "doctor-pack-missing")).toBe(
      true
    )
    expect(readdirSync(cacheDir)).toEqual([])
    expect(driftResult.machineOutput.status).toBe(1)
    expect(readdirSync(cacheDir)).toEqual([])
  })
})

describe("packs status", () => {
  const tempCacheWithPack = (manifest: ReferencePack.PackManifest): string => {
    const dir = track(mkdtempSync(join(tmpdir(), "el-status-cache-")))
    const packDir = join(dir, manifest.id)
    mkdirSync(packDir, { recursive: true })
    for (const p of manifest.includedPaths) {
      const file = join(packDir, p)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "content")
    }
    writeManifest(packDir, manifest)
    return dir
  }

  it("reports verified for an exact pack matching the catalog baseline", () => {
    const entry = makeEntry()
    const cacheDir = tempCacheWithPack(entry)
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as {
      report: { status: string; candidateBaselines: Array<{ id: string }> }
    }
    expect(json.report.status).toBe("verified")
    expect(json.report.candidateBaselines).toEqual([])
  })

  it("reports absent without mutating the cache", () => {
    const cacheDir = tempCache()
    const entry = makeEntry()
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(1)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("absent")
    expect(readdirSync(cacheDir)).toEqual([])
  })

  it("reports stale when the only cached pack lags the exact version", () => {
    const lagEntry = makeEntry({ id: "pack-effect-100", version: "4.0.0-rc.100" })
    const cacheDir = tempCacheWithPack(lagEntry)
    const entry = makeEntry()
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(1)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("stale")
  })

  it("reports corrupt when the exact pack misses a declared file", () => {
    const entry = makeEntry()
    const cacheDir = tempCacheWithPack(entry)
    // Remove one declared file so the exact pack is self-inconsistent.
    rmSync(join(cacheDir, entry.id, "ai-docs", "guide.md"))
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(1)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("corrupt")
  })

  it("reports an unresolved target as a blocking error", () => {
    const entry = makeEntry()
    const cacheDir = tempCache()
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({
      projectDir: project("missing-dependency"),
      cacheDir,
      catalogDir
    })
    expect(result.machineOutput.status).toBe(2)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("unresolved")
  })

  it("is read-only and never promotes a pack", () => {
    const cacheDir = tempCache()
    const entry = makeEntry({ sourceUrl: pathToFileURL(join(tmpdir(), "missing")).href })
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(1)
    expect(existsSync(join(cacheDir, entry.id))).toBe(false)
    expect(readdirSync(cacheDir)).toEqual([])
  })

  it("reports complete when no catalog baseline matches the intact exact pack", () => {
    const entry = makeEntry()
    const cacheDir = tempCacheWithPack(entry)
    const other = makeEntry({ id: "pack-effect-100", version: "4.0.0-rc.100" })
    const catalogDir = tempCatalog(other)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(0)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("complete")
  })

  it("reports mismatched when the exact pack diverges from the catalog baseline", () => {
    const divergent = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: PackageIdentity.makePackageIdentity({
        name: "effect",
        version: "4.0.0-rc.109",
        source: "lockfile"
      }),
      upstream: Provenance.makeUpstreamRef({
        repository: "effect-ts/effect",
        ref: "v4.0.0-rc.109",
        commit: "a-different-commit"
      }),
      includedPaths: [...INCLUDED],
      status: "complete"
    })
    const cacheDir = tempCacheWithPack(divergent)
    const entry = makeEntry()
    const catalogDir = tempCatalog(entry)
    const result = packsStatus({ projectDir: project("pnpm-valid"), cacheDir, catalogDir })
    expect(result.machineOutput.status).toBe(1)
    const json = result.json as { report: { status: string } }
    expect(json.report.status).toBe("mismatched")
  })
})
