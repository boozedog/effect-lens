import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Finding from "../src/Finding.ts"
import * as Guidance from "../src/Guidance.ts"
import * as Provenance from "../src/Provenance.ts"

const evidence = Provenance.makeEvidence({
  source: "packages/effect/src/Effect.ts",
  ref: "v4.0.0-rc.109",
  location: "src/Effect.ts:120"
})

const appliesTo = Guidance.makeAppliesTo({ from: "4.0.0" })

const finding = Finding.makeFinding({
  id: "f-1",
  rule: "lens/no-async-function",
  severity: "error",
  source: "lens-strict",
  message: "async/await is not an Effect-first composition strategy",
  appliesTo,
  location: Finding.makeLocation({ file: "src/service.ts", line: 14, column: 3 }),
  evidence: [evidence]
})

describe("Finding", () => {
  it("carries every provenance field a recommendation needs", () => {
    expect(finding.rule).toBe("lens/no-async-function")
    expect(finding.severity).toBe("error")
    expect(finding.source).toBe("lens-strict")
    expect(finding.location.file).toBe("src/service.ts")
    expect(finding.location.line).toBe(14)
    expect(finding.evidence).toHaveLength(1)
    expect(finding.evidence[0].ref).toEqual(Option.some("v4.0.0-rc.109"))
  })

  it("preserves version applicability", () => {
    const applies = Option.getOrThrow(finding.appliesTo)
    expect(applies.from).toBe("4.0.0")
  })

  it("rejects a finding without a rule id", () => {
    const bad = { ...Schema.encodeSync(Finding.Finding)(finding), rule: "" }
    expect(Option.isNone(Schema.decodeUnknownOption(Finding.Finding)(bad))).toBe(true)
  })

  it("rejects a finding with an unknown severity", () => {
    const bad = { ...Schema.encodeSync(Finding.Finding)(finding), severity: "fatal" }
    expect(Option.isNone(Schema.decodeUnknownOption(Finding.Finding)(bad))).toBe(true)
  })

  it("serializes to JSON and back losslessly", () => {
    const json = Schema.encodeSync(Finding.Finding)(finding)
    const decoded = Schema.decodeUnknownSync(Finding.Finding)(json)
    expect(Schema.encodeSync(Finding.Finding)(decoded)).toEqual(json)
  })
})
