import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Design from "../../src/operations/design.ts"
import * as StatePressure from "../../src/operations/statePressure.ts"

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/state-pressure/${name}`, import.meta.url)),
    "utf8"
  )

const analyze = (name: string, file = `src/${name}`): StatePressure.StatePressureResult =>
  StatePressure.analyzeStatePressure({ file, source: fixture(name) })

const roundTrip = <A>(schema: Schema.Schema<A>, value: A): void => {
  const json = Schema.encodeSync(schema as any)(value)
  const decoded = Schema.decodeUnknownSync(schema as any)(json) as A
  expect(Schema.encodeSync(schema as any)(decoded)).toEqual(json)
}

describe("statePressure", () => {
  it("recommends a machine for a multi-state event/effect workflow", () => {
    const result = analyze("multi-state-workflow.ts")
    expect(result.recommendation).toBe(true)
    expect(result.suppressed).toBe(false)
    expect(result.score).toBeGreaterThanOrEqual(3)
    expect(result.confidence).toBeGreaterThan(0)
    const kinds = result.signals.map((s) => s.kind)
    expect(kinds).toContain("discriminated-union")
    expect(kinds).toContain("repeated-switch")
    expect(kinds).toContain("event-protocol")
    expect(kinds).toContain("state-dependent-effect")
    expect(Option.isSome(result.message)).toBe(true)
  })

  it("recommends a machine for independent boolean flags with parallel state", () => {
    const result = analyze("independent-flags.ts")
    expect(result.recommendation).toBe(true)
    const kinds = result.signals.map((s) => s.kind)
    expect(kinds).toContain("boolean-flags")
    expect(kinds).toContain("repeated-switch")
    expect(kinds).toContain("state-dependent-effect")
  })

  it("recommends a machine for a workflow with persistence and recovery", () => {
    const result = analyze("persist-recover.ts")
    expect(result.recommendation).toBe(true)
    const kinds = result.signals.map((s) => s.kind)
    expect(kinds).toContain("persistence")
    expect(kinds).toContain("event-protocol")
    expect(kinds).toContain("state-dependent-effect")
  })

  it("recommends only when boolean flags push the score over the threshold", () => {
    const withFlags = analyze("flags-driven.ts")
    expect(withFlags.recommendation).toBe(true)
    expect(withFlags.signals.map((s) => s.kind)).toContain("boolean-flags")

    // The same workflow without the flags stays below the threshold.
    const withoutFlags = fixture("flags-driven.ts").replace(
      /export interface Flags[\s\S]*?\n}\n/,
      ""
    )
    const result = StatePressure.analyzeStatePressure({
      file: "src/flags-driven.ts",
      source: withoutFlags
    })
    expect(result.recommendation).toBe(false)
    expect(result.signals.map((s) => s.kind)).not.toContain("boolean-flags")
  })

  it("does not recommend for a trivial status switch", () => {
    const result = analyze("trivial-switch.ts")
    expect(result.recommendation).toBe(false)
    expect(result.suppressed).toBe(false)
    // A single union alone is not enough.
    expect(result.signals.length).toBeLessThan(2)
  })

  it("does not recommend for a small status/handle workflow with a stray Effect", () => {
    for (
      const name of ["small-status-effect.ts", "small-reducer-gen.ts", "small-reducer-snapshot.ts"]
    ) {
      const result = analyze(name)
      expect(result.recommendation).toBe(false)
      expect(result.suppressed).toBe(false)
    }
  })

  it("emits discriminated-union for a union not named State/Status/Phase/Mode", () => {
    const result = analyze("job-workflow.ts")
    expect(result.signals.map((s) => s.kind)).toContain("discriminated-union")
    // A single discriminated union alone does not recommend.
    expect(result.recommendation).toBe(false)
  })

  it("suppresses already-modeled state-machine code", () => {
    const result = analyze("already-modeled.ts")
    expect(result.suppressed).toBe(true)
    expect(result.recommendation).toBe(false)
    expect(Option.getOrNull(result.suppressionReason)).toBe("already uses a state-machine library")
  })

  it("suppresses generated code", () => {
    const result = analyze("generated.ts")
    expect(result.suppressed).toBe(true)
    expect(result.recommendation).toBe(false)
    expect(Option.getOrNull(result.suppressionReason)).toBe("generated code")
  })

  it("suppresses test files by path", () => {
    const result = StatePressure.analyzeStatePressure({
      file: "src/workflow.test.ts",
      source: fixture("multi-state-workflow.ts")
    })
    expect(result.suppressed).toBe(true)
    expect(result.recommendation).toBe(false)
    expect(Option.getOrNull(result.suppressionReason)).toBe("test file")
  })

  it("does not suppress a comment that merely mentions a state-machine library", () => {
    const source = [
      "// This workflow could use xstate, but it is not imported.",
      "export type Status = 'idle' | 'active'",
      "export const f = (s: Status): string => {",
      "  switch (s) { case 'idle': return 'i'; case 'active': return 'a'; default: return 'x' }",
      "}"
    ].join("\n")
    const result = StatePressure.analyzeStatePressure({ file: "src/comment.ts", source })
    expect(result.suppressed).toBe(false)
  })

  it("does not suppress a header that merely contains the word generated", () => {
    const source = [
      "// user-generated report IDs are stable across runs.",
      "export type Status = 'idle' | 'active'",
      "export const f = (s: Status): string => {",
      "  switch (s) { case 'idle': return 'i'; case 'active': return 'a'; default: return 'x' }",
      "}"
    ].join("\n")
    const result = StatePressure.analyzeStatePressure({ file: "src/header.ts", source })
    expect(result.suppressed).toBe(false)
  })

  it("emits evidence-backed facts with source locations", () => {
    const result = analyze("multi-state-workflow.ts")
    expect(result.facts.length).toBeGreaterThan(0)
    for (const fact of result.facts) {
      expect(fact.kind).toBe("state-pressure")
      expect(fact.key.length).toBeGreaterThan(0)
      expect(fact.value.length).toBeGreaterThan(0)
      const evidence = Option.getOrNull(fact.evidence)
      expect(evidence).not.toBeNull()
      expect(evidence?.source).toBe("src/multi-state-workflow.ts")
      expect(Option.getOrNull(evidence?.location ?? Option.none())).toMatch(
        /^src\/multi-state-workflow\.ts:\d+$/
      )
    }
    // Signals carry file:line locations, including boolean-flags and
    // transition-spread (which point at a real line, not file:1).
    for (const signal of result.signals) {
      const location = Option.getOrNull(signal.location)
      expect(location).toMatch(/^src\/multi-state-workflow\.ts:\d+$/)
      expect(location).not.toBe("src/multi-state-workflow.ts:1")
    }
  })

  it("does not recommend for a single union alone (threshold behavior)", () => {
    const source = "export type State = { kind: 'a' } | { kind: 'b' }"
    const result = StatePressure.analyzeStatePressure({ file: "src/single.ts", source })
    expect(result.recommendation).toBe(false)
    expect(result.signals.length).toBeLessThan(2)
  })

  it("does not recommend for a single switch alone (threshold behavior)", () => {
    const source = [
      "export type Status = 'idle' | 'active'",
      "export const f = (s: Status): string => {",
      "  switch (s) { case 'idle': return 'i'; case 'active': return 'a'; default: return 'x' }",
      "}"
    ].join("\n")
    const result = StatePressure.analyzeStatePressure({ file: "src/single.ts", source })
    expect(result.recommendation).toBe(false)
  })

  it("detects if/else comparisons over a discriminator as transitions", () => {
    const source = [
      "export type State = { kind: 'idle' } | { kind: 'running' } | { kind: 'done' }",
      "export const reducer = (s: State): State => {",
      "  if (s.kind === 'idle') return { kind: 'running' }",
      "  if (s.kind === 'running') return { kind: 'done' }",
      "  return s",
      "}",
      "export const run = (s: State): State => {",
      "  if (s.kind === 'running') return { kind: 'done' }",
      "  return s",
      "}"
    ].join("\n")
    const result = StatePressure.analyzeStatePressure({ file: "src/ifelse.ts", source })
    expect(result.signals.map((s) => s.kind)).toContain("repeated-switch")
  })

  it("does not treat an unrelated boolean comparison as a transition", () => {
    const source = [
      "export type State = { kind: 'a' } | { kind: 'b' }",
      "export function handle(s: State): State {",
      "  if (ok === true) return s",
      "  if (ok === false) return s",
      "  return s",
      "}"
    ].join("\n")
    const result = StatePressure.analyzeStatePressure({ file: "src/bool.ts", source })
    expect(result.signals.map((s) => s.kind)).not.toContain("repeated-switch")
    expect(result.recommendation).toBe(false)
  })

  it("produces deterministic score and confidence", () => {
    const a = analyze("multi-state-workflow.ts")
    const b = analyze("multi-state-workflow.ts")
    expect(a.score).toBe(b.score)
    expect(a.confidence).toBe(b.confidence)
    expect(a.confidence).toBeGreaterThan(0)
    expect(a.confidence).toBeLessThanOrEqual(1)
  })

  it("round-trips through JSON", () => {
    const result = analyze("multi-state-workflow.ts")
    roundTrip(StatePressure.StatePressureResult, result)
  })

  it("builds an effect-machine DesignAdvice only when recommended", () => {
    const positive = analyze("multi-state-workflow.ts")
    const advice = StatePressure.statePressureAdvice(positive)
    expect(Option.isSome(advice)).toBe(true)
    if (Option.isSome(advice)) {
      expect(advice.value.guidance.id).toBe("effect-machine")
      expect(advice.value.guidance.source).toBe("lens-advisory")
      expect(advice.value.applicable).toBe(true)
      expect(advice.value.versionStatus).toBe("unknown")
      expect(advice.value.confidence).toBe(positive.confidence)
    }

    const negative = analyze("trivial-switch.ts")
    expect(Option.isNone(StatePressure.statePressureAdvice(negative))).toBe(true)
  })

  it("includes a machine-concept mapping in the recommendation message", () => {
    const result = analyze("persist-recover.ts")
    const message = Option.getOrNull(result.message)
    expect(message).not.toBeNull()
    expect(message).toContain("states")
    expect(message).toContain("public events")
    expect(message).toContain("invokes")
    expect(message).toContain("snapshots")
  })

  it("integrates with design to surface explicit effect-machine guidance", () => {
    const result = analyze("multi-state-workflow.ts")
    const designed = StatePressure.designWithStatePressure({
      request: Design.makeDesignRequest({
        feature: "orchestrate a workflow",
        effectVersion: "4.0.0"
      }),
      result
    })
    const machine = designed.advice.find((a) => a.guidance.id === "effect-machine")
    expect(machine).toBeDefined()
    expect(machine?.guidance.source).toBe("lens-advisory")
    expect(machine?.confidence).toBe(result.confidence)
    expect(designed.advice.length).toBeGreaterThan(0)
  })

  it("does not surface effect-machine guidance for a trivial case", () => {
    const result = analyze("trivial-switch.ts")
    const designed = StatePressure.designWithStatePressure({
      request: Design.makeDesignRequest({
        feature: "label a status",
        effectVersion: "4.0.0"
      }),
      result
    })
    expect(designed.advice.find((a) => a.guidance.id === "effect-machine")).toBeUndefined()
  })
})
