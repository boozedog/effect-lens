import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import * as GuidanceIngestor from "../src/GuidanceIngestor.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const ingestDir = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/ingest/${name}`, import.meta.url))

const manifest = (
  id: string,
  effectVersion: string,
  includedPaths: Array<string>
): ReferencePack.PackManifest =>
  ReferencePack.makePackManifest({
    id,
    effectVersion,
    packageIdentity: PackageIdentity.makePackageIdentity({
      name: "effect",
      version: effectVersion,
      source: "lockfile"
    }),
    upstream: Provenance.makeUpstreamRef({
      repository: "effect-ts/effect",
      ref: `v${effectVersion}`,
      commit: "deadbeef"
    }),
    includedPaths,
    status: "complete"
  })

// `upstreamRef.ref` is itself an `Option<string>`; unwrap both layers.
const upstreamRefOf = (g: GuidanceIngestor.Guidance): string | null =>
  Option.getOrNull(Option.getOrNull(g.upstreamRef)?.ref ?? Option.none())

const appliesToOf = (g: GuidanceIngestor.Guidance): { from: string; to: string | null } => {
  const window = Option.getOrNull(g.appliesTo)
  return {
    from: window?.from ?? "",
    to: Option.getOrNull(window?.to ?? Option.none())
  }
}

describe("ingestPackDir", () => {
  it("ingests well-formed guidance with evidence and version applicability", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("valid") })
    expect(result.status).toBe("ok")
    expect(result.guidance).toHaveLength(3)
    expect(result.diagnostics).toEqual([])

    const piping = result.guidance.find((g) => g.topic === "Piping")
    expect(piping).toBeDefined()
    const p = piping!
    expect(p.validationStatus).toBe("validated")
    expect(p.source).toBe("upstream")
    expect(appliesToOf(p)).toEqual({ from: "4.0.0", to: null })
    expect(upstreamRefOf(p)).toBe("v4.0.0-rc.109")
    expect(p.evidence[0].source).toBe("LLMS.md")
    expect(p.evidence[0].ref).toEqual(Option.some("v4.0.0-rc.109"))
    expect(Option.getOrNull(p.evidence[0].location)).toBe("LLMS.md:3")

    const layers = result.guidance.find((g) => g.topic === "Layers")
    expect(layers).toBeDefined()
    const l = layers!
    expect(l.validationStatus).toBe("validated")
    expect(appliesToOf(l)).toEqual({ from: "4.0.0", to: "4.1.0" })
  })

  it("honors a ref override that differs from the pack upstream ref", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("valid") })
    const layers = result.guidance.find((g) => g.topic === "Layers")
    expect(layers).toBeDefined()
    // The pack upstream ref is v4.0.0-rc.109; the block overrides it.
    expect(upstreamRefOf(layers!)).toBe("v4.0.0-rc.110")
    expect(layers!.evidence[0].ref).toEqual(Option.some("v4.0.0-rc.110"))
  })

  it("clears the pack commit when the ref is overridden", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("valid") })
    const layers = result.guidance.find((g) => g.topic === "Layers")
    expect(layers).toBeDefined()
    const upstream = Option.getOrNull(layers!.upstreamRef)
    expect(upstream?.ref).toEqual(Option.some("v4.0.0-rc.110"))
    expect(Option.isNone(upstream?.commit ?? Option.none())).toBe(true)
  })

  it("defaults version applicability and ref to the pack when metadata is absent", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("valid") })
    const testing = result.guidance.find((g) => g.topic === "Testing")
    expect(testing).toBeDefined()
    const t = testing!
    expect(t.validationStatus).toBe("validated")
    expect(appliesToOf(t).from).toBe("4.0.0-rc.109")
    expect(upstreamRefOf(t)).toBe("v4.0.0-rc.109")
  })

  it("surfaces malformed blocks as unvalidated with diagnostics", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("malformed") })
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(2)

    const noSummary = result.guidance.find((g) => g.topic === "No summary")
    expect(noSummary).toBeDefined()
    expect(noSummary!.validationStatus).toBe("unvalidated")

    const badWindow = result.guidance.find((g) => g.topic === "Bad window")
    expect(badWindow).toBeDefined()
    expect(badWindow!.validationStatus).toBe("unvalidated")
    // The malformed window falls back to the pack version rather than dropping the record.
    expect(appliesToOf(badWindow!).from).toBe("4.0.0-rc.109")

    const messages = result.diagnostics.map((d) => d.message)
    expect(messages).toContain("guidance block has no summary")
    expect(messages).toContain("invalid applies-to window: not-a-version")
  })

  it("surfaces conflicting guidance as conflict with diagnostics", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("conflict") })
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(2)
    for (const g of result.guidance) {
      expect(g.topic).toBe("Piping")
      expect(g.validationStatus).toBe("conflict")
    }
    expect(result.diagnostics.some((d) => d.message.includes("conflicting guidance"))).toBe(true)
  })

  it("does not let an invalid applies-to mark a disjoint sibling as conflict", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("invalid-window") })
    // The `not-a-version` block is unvalidated with a fallback window; it must
    // not drag the well-formed 5.0.0..6.0.0 sibling into a conflict.
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(2)
    const bySummary = new Map(result.guidance.map((g) => [g.summary, g.validationStatus]))
    expect(bySummary.get("Use `Effect.pipe`.")).toBe("validated")
    expect(bySummary.get("Never use `pipe`.")).toBe("unvalidated")
    expect(result.diagnostics.some((d) => d.message.includes("conflicting guidance"))).toBe(false)
  })

  it("flags only the overlapping contradictory pair, not disjoint siblings", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("conflict-3") })
    // Three same-topic blocks: the first two windows overlap (3.0.0..4.0.0 and
    // 3.5.0..4.5.0) with different summaries; the third (5.0.0) is disjoint.
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(3)
    const bySummary = new Map(result.guidance.map((g) => [g.summary, g.validationStatus]))
    expect(bySummary.get("Use `pipe` for composition.")).toBe("conflict")
    expect(bySummary.get("Never use `pipe`.")).toBe("conflict")
    expect(bySummary.get("Use `Effect.pipe`.")).toBe("validated")
    expect(result.diagnostics.some((d) => d.message.includes("conflicting guidance"))).toBe(true)
  })

  it("detects overlap between a default rc window and a release window", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("version-overlap") })
    // Default window 4.0.0-rc.109 overlaps 3.0.0..4.0.0 (rc.109 < 4.0.0).
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(2)
    for (const g of result.guidance) {
      expect(g.validationStatus).toBe("conflict")
    }
  })

  it("compares prerelease identifiers when detecting overlap", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("version-prerelease") })
    // 4.0.0-rc.1..4.0.0 and 4.0.0-rc.50..4.1.0 overlap.
    expect(result.status).toBe("partial")
    expect(result.guidance).toHaveLength(2)
    for (const g of result.guidance) {
      expect(g.validationStatus).toBe("conflict")
    }
  })

  it("does not flag same-topic/same-summary blocks as conflict", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("non-conflict") })
    expect(result.status).toBe("ok")
    expect(result.guidance).toHaveLength(2)
    for (const g of result.guidance) {
      expect(g.topic).toBe("Piping")
      expect(g.validationStatus).toBe("validated")
    }
  })

  it("does not flag same-topic blocks with non-overlapping version windows", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("versioned") })
    expect(result.status).toBe("ok")
    expect(result.guidance).toHaveLength(2)
    for (const g of result.guidance) {
      expect(g.topic).toBe("Piping")
      expect(g.validationStatus).toBe("validated")
    }
    const windows = result.guidance.map(appliesToOf)
    expect(windows).toContainEqual({ from: "3.0.0", to: "4.0.0" })
    expect(windows).toContainEqual({ from: "4.0.0", to: null })
  })

  it("preserves heading hierarchy so repeated structural headings do not collide", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("hierarchy") })
    expect(result.status).toBe("ok")
    expect(result.guidance).toHaveLength(5)
    for (const g of result.guidance) {
      expect(g.validationStatus).toBe("validated")
    }
    const topics = result.guidance.map((g) => g.topic)
    expect(topics).toContain("Piping")
    expect(topics).toContain("Layers")
    const morePiping = result.guidance.filter((g) => g.topic === "Piping > More examples")
    expect(morePiping).toHaveLength(2)
    expect(morePiping[0].validationStatus).toBe("validated")
    expect(topics).toContain("Layers > More examples")
  })

  it("produces unique ids across files with the same heading at the same line", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("unique-ids") })
    expect(result.guidance).toHaveLength(2)
    const ids = result.guidance.map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it("keeps ids unique for paths that collide under a lossy slug", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("path-collision") })
    expect(result.guidance).toHaveLength(2)
    const ids = result.guidance.map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it("rejects included paths that resolve outside the pack directory", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("traversal") })
    expect(result.status).toBe("partial")
    expect(result.guidance).toEqual([])
    expect(result.diagnostics.some((d) => d.message.includes("outside the pack directory"))).toBe(
      true
    )
  })

  it("recurses markdown under an included directory", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("directory") })
    expect(result.status).toBe("ok")
    expect(result.guidance).toHaveLength(2)
    const sources = result.guidance.map((g) => g.evidence[0].source)
    expect(sources).toContain("ai-docs/guide.md")
    expect(sources).toContain("ai-docs/sub/extra.md")
  })

  it("warns on an unclosed code fence", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("unclosed-fence") })
    expect(result.status).toBe("partial")
    expect(result.diagnostics.some((d) => d.message.includes("unclosed code fence"))).toBe(true)
  })

  it("copies pack attribution onto each evidence record", () => {
    const result = GuidanceIngestor.ingestPackDir({ packDir: ingestDir("attribution") })
    expect(result.guidance).toHaveLength(1)
    const attribution = Option.getOrNull(result.guidance[0].evidence[0].attribution)
    expect(attribution).toContain("MIT")
    expect(attribution).toContain("Effect contributors")
  })

  it("reports failed when the pack manifest is missing or unparseable", () => {
    const result = GuidanceIngestor.ingestPackDir({
      packDir: fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url))
    })
    expect(result.status).toBe("failed")
    expect(result.guidance).toEqual([])
    expect(Option.isNone(result.pack)).toBe(true)
    expect(result.diagnostics[0].message).toContain("manifest")
  })
})

describe("ingestPack", () => {
  it("ingests an exact verified pack from the cache", () => {
    const result = GuidanceIngestor.ingestPack({
      cacheDir,
      manifest: manifest("pack-effect-109", "4.0.0-rc.109", ["LLMS.md", "ai-docs/guide.md"])
    })
    // The committed cache fixtures are title-only (a single H1), so they carry
    // no guidance blocks; the ingestor reports that rather than inventing records.
    expect(result.status).toBe("partial")
    expect(result.guidance).toEqual([])
    expect(Option.isSome(result.pack)).toBe(true)
    expect(result.diagnostics.some((d) => d.message.includes("no guidance blocks found"))).toBe(
      true
    )
  })

  it("reports missing included files as diagnostics", () => {
    const result = GuidanceIngestor.ingestPack({
      cacheDir,
      manifest: manifest("pack-effect-109", "4.0.0-rc.109", ["LLMS.md", "missing.md"])
    })
    expect(result.status).toBe("partial")
    expect(result.diagnostics.some((d) => d.message.includes("missing.md"))).toBe(true)
  })
})
