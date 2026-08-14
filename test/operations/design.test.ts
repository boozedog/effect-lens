import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as Guidance from "../../src/Guidance.ts"
import * as Design from "../../src/operations/design.ts"
import * as Provenance from "../../src/Provenance.ts"

const guidance = (args: {
  id: string
  topic: string
  summary: string
  from?: string
  to?: string | null
  validationStatus?: Guidance.GuidanceValidationStatus
}): Guidance.Guidance =>
  Guidance.makeGuidance({
    id: args.id,
    topic: args.topic,
    summary: args.summary,
    source: "upstream",
    validationStatus: args.validationStatus ?? "validated",
    evidence: [Provenance.makeEvidence({ source: "LLMS.md", ref: "v4.0.0-rc.109" })],
    appliesTo: Guidance.makeAppliesTo({ from: args.from ?? "4.0.0", to: args.to ?? null })
  })

const piping = guidance({
  id: "g-pipe",
  topic: "Piping",
  summary: "Prefer `pipe` for composition."
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

describe("design", () => {
  it("combines analysis facts with guidance into ranked advice", () => {
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose two services",
        effectVersion: "4.0.0",
        facts: [Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" })],
        guidance: [piping]
      })
    })
    expect(result.advice).toHaveLength(1)
    const advice = result.advice[0]
    expect(advice.guidance.id).toBe("g-pipe")
    expect(advice.applicable).toBe(true)
    expect(advice.versionStatus).toBe("current")
    expect(advice.confidence).toBeGreaterThan(0.8)
    expect(result.diagnostics).toEqual([])
  })

  it("ranks higher-confidence advice first", () => {
    const unvalidated = guidance({
      id: "g-unvalidated",
      topic: "Piping",
      summary: "Prefer `pipe`.",
      validationStatus: "unvalidated"
    })
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts: [Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" })],
        guidance: [unvalidated, piping]
      })
    })
    expect(result.advice.map((a) => a.guidance.id)).toEqual(["g-pipe", "g-unvalidated"])
    expect(result.advice[0].confidence).toBeGreaterThan(result.advice[1].confidence)
  })

  it("flags incompatible guidance as inapplicable with a diagnostic", () => {
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        guidance: [stale]
      })
    })
    expect(result.advice[0].applicable).toBe(false)
    expect(result.advice[0].versionStatus).toBe("stale")
    expect(result.advice[0].confidence).toBeLessThanOrEqual(0.3)
    expect(result.diagnostics.some((d) => d.id === "design-incompatible-g-old")).toBe(true)
  })

  it("flags conflict guidance with a diagnostic", () => {
    const conflicting = guidance({
      id: "g-conflict",
      topic: "Piping",
      summary: "Never use `pipe`.",
      validationStatus: "conflict"
    })
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        guidance: [conflicting]
      })
    })
    expect(result.diagnostics.some((d) => d.id === "design-conflict-g-conflict")).toBe(true)
    expect(result.advice[0].confidence).toBe(0.2)
  })

  it("never boosts conflict guidance to high confidence", () => {
    const conflicting = guidance({
      id: "g-conflict",
      topic: "Piping",
      summary: "Never use `pipe`.",
      validationStatus: "conflict"
    })
    // Keys/values that match the topic ("Piping") and summary ("Never use
    // `pipe`.") so a removed cap would push confidence above 0.3.
    const facts = [
      Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" }),
      Design.makeAnalysisFact({ kind: "ast", key: "pip", value: "never" }),
      Design.makeAnalysisFact({ kind: "ast", key: "piping", value: "use" })
    ]
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts,
        guidance: [conflicting]
      })
    })
    // Conflict guidance is capped at 0.3 regardless of how many facts match.
    expect(result.advice[0].confidence).toBeLessThanOrEqual(0.3)
  })

  it("counts each fact key and value at most once", () => {
    const duplicate = Array.from(
      { length: 5 },
      () => Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" })
    )
    const single = [Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" })]
    const withDuplicates = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts: duplicate,
        guidance: [piping]
      })
    })
    const withSingle = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts: single,
        guidance: [piping]
      })
    })
    expect(withDuplicates.advice[0].confidence).toBe(withSingle.advice[0].confidence)
  })

  it("accepts kind-tagged facts from a future state-pressure analyzer", () => {
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts: [
          Design.makeAnalysisFact({
            kind: "state-pressure",
            key: "state",
            value: "high"
          })
        ],
        guidance: [piping]
      })
    })
    // The state-pressure fact is accepted without changing the contract.
    expect(result.advice).toHaveLength(1)
    expect(result.advice[0].guidance.id).toBe("g-pipe")
  })

  it("round-trips through JSON", () => {
    const result = Design.design({
      request: Design.makeDesignRequest({
        feature: "compose",
        effectVersion: "4.0.0",
        facts: [Design.makeAnalysisFact({ kind: "ast", key: "pipe", value: "pipe" })],
        guidance: [piping, stale]
      })
    })
    roundTrip(Design.DesignResult, result)
  })
})
