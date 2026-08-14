import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { fileURLToPath } from "node:url"
import * as Guidance from "../../src/Guidance.ts"
import * as GuidanceIngestor from "../../src/GuidanceIngestor.ts"
import * as Lookup from "../../src/operations/lookup.ts"
import * as Provenance from "../../src/Provenance.ts"

const guidance = (args: {
  id: string
  topic: string
  summary: string
  from?: string
  to?: string | null
  validationStatus?: Guidance.GuidanceValidationStatus
  source?: "upstream" | "lens-strict"
}): Guidance.Guidance =>
  Guidance.makeGuidance({
    id: args.id,
    topic: args.topic,
    summary: args.summary,
    source: args.source ?? "upstream",
    validationStatus: args.validationStatus ?? "validated",
    evidence: [Provenance.makeEvidence({ source: "LLMS.md", ref: "v4.0.0-rc.109" })],
    appliesTo: Guidance.makeAppliesTo({ from: args.from ?? "4.0.0", to: args.to ?? null })
  })

const piping = guidance({
  id: "g-pipe",
  topic: "Piping",
  summary: "Prefer `pipe` for composition."
})
const layers = guidance({
  id: "g-layer",
  topic: "Layers",
  summary: "Prefer `Layer` for dependency management.",
  from: "4.0.0",
  to: "4.1.0"
})
const stale = guidance({
  id: "g-old",
  topic: "Piping",
  summary: "Use the legacy `pipe` helper.",
  from: "3.0.0",
  to: "4.0.0"
})

const roundTrip = <A>(schema: Schema.Schema<A>, value: A): void => {
  const json = Schema.encodeSync(schema as any)(value)
  const decoded = Schema.decodeUnknownSync(schema as any)(json) as A
  expect(Schema.encodeSync(schema as any)(decoded)).toEqual(json)
}

describe("lookup", () => {
  it("returns ranked, evidence-backed matches with provenance", () => {
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: [piping, layers]
    })
    expect(result.matches).toHaveLength(1)
    const match = result.matches[0]
    expect(match.guidance.id).toBe("g-pipe")
    expect(match.score).toBeGreaterThan(0)
    expect(match.applicable).toBe(true)
    expect(match.versionStatus).toBe("current")
    expect(Option.isSome(match.guidance.evidence[0].ref)).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it("ranks topic matches above summary-only matches", () => {
    const summaryOnly = guidance({
      id: "g-summary",
      topic: "Composition",
      summary: "Use `pipe` for composition."
    })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping composition", effectVersion: "4.0.0" }),
      guidance: [summaryOnly, piping]
    })
    expect(result.matches.map((m) => m.guidance.id)).toEqual(["g-pipe", "g-summary"])
    expect(result.matches[0].score).toBeGreaterThan(result.matches[1].score)
  })

  it("returns no matches and a diagnostic for an unmatched query", () => {
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "zzz-nothing", effectVersion: "4.0.0" }),
      guidance: [piping, layers]
    })
    expect(result.matches).toEqual([])
    expect(result.diagnostics.some((d) => d.id === "lookup-no-matches")).toBe(true)
  })

  it("flags a stale reference as inapplicable with a diagnostic", () => {
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: [stale]
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].applicable).toBe(false)
    expect(result.matches[0].versionStatus).toBe("stale")
    expect(result.diagnostics.some((d) => d.id === "lookup-incompatible-g-old")).toBe(true)
  })

  it("marks guidance without a version window as unknown and inapplicable", () => {
    const noWindow = guidance({
      id: "g-nowindow",
      topic: "Piping",
      summary: "Prefer `pipe`."
    })
    // Strip the appliesTo window to simulate a record without version metadata.
    const stripped = Guidance.makeGuidance({
      id: noWindow.id,
      topic: noWindow.topic,
      summary: noWindow.summary,
      source: noWindow.source,
      validationStatus: noWindow.validationStatus,
      evidence: [...noWindow.evidence],
      appliesTo: null
    })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: [stripped]
    })
    expect(result.matches[0].applicable).toBe(false)
    expect(result.matches[0].versionStatus).toBe("unknown")
  })

  it("flags conflict guidance with a diagnostic", () => {
    const conflicting = guidance({
      id: "g-conflict",
      topic: "Piping",
      summary: "Never use `pipe`.",
      validationStatus: "conflict"
    })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: [conflicting]
    })
    expect(result.diagnostics.some((d) => d.id === "lookup-conflict-g-conflict")).toBe(true)
  })

  it("honors the source filter", () => {
    const lensStrict = guidance({
      id: "g-strict",
      topic: "Piping",
      summary: "Lens strict policy.",
      source: "lens-strict"
    })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({
        query: "piping",
        effectVersion: "4.0.0",
        source: "lens-strict"
      }),
      guidance: [piping, lensStrict]
    })
    expect(result.matches.map((m) => m.guidance.id)).toEqual(["g-strict"])
  })

  it("caps results at the requested limit", () => {
    const a = guidance({ id: "g-a", topic: "Piping", summary: "A." })
    const b = guidance({ id: "g-b", topic: "Piping", summary: "B." })
    const c = guidance({ id: "g-c", topic: "Piping", summary: "C." })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0", limit: 2 }),
      guidance: [a, b, c]
    })
    expect(result.matches).toHaveLength(2)
  })

  it("does not drop current guidance when stale hits fill the limit", () => {
    const stale2 = guidance({
      id: "g-old2",
      topic: "Piping",
      summary: "Another legacy `pipe` note.",
      from: "3.0.0",
      to: "4.0.0"
    })
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0", limit: 2 }),
      guidance: [stale, stale2, piping]
    })
    // Applicable matches are prioritized, so the current `piping` record must
    // appear even though two stale same-topic hits would otherwise fill the limit.
    expect(result.matches.map((m) => m.guidance.id)).toContain("g-pipe")
    expect(result.matches[0].guidance.id).toBe("g-pipe")
    expect(result.matches[0].applicable).toBe(true)
  })

  it("round-trips through JSON", () => {
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: [piping, stale]
    })
    roundTrip(Lookup.LookupResult, result)
  })

  it("searches guidance ingested from a real pack", () => {
    const ingestDir = fileURLToPath(new URL("../fixtures/ingest/valid", import.meta.url))
    const ingested = GuidanceIngestor.ingestPackDir({ packDir: ingestDir })
    expect(ingested.status).toBe("ok")
    const result = Lookup.lookup({
      query: Lookup.makeLookupQuery({ query: "piping", effectVersion: "4.0.0" }),
      guidance: ingested.guidance
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].guidance.topic).toBe("Piping")
    expect(result.matches[0].applicable).toBe(true)
    expect(result.matches[0].versionStatus).toBe("current")
    expect(Option.isSome(result.matches[0].guidance.evidence[0].ref)).toBe(true)
  })
})
