import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Waiver from "../src/Waiver.ts"

const waiver = Waiver.makeWaiver({
  id: "w-1",
  rule: "lens/no-async-function",
  scope: "file",
  path: "src/bridge.ts",
  reason: "Interop boundary with a legacy callback API.",
  createdBy: "david"
})

describe("Waiver", () => {
  it("carries rule id, scope, and reason metadata", () => {
    expect(waiver.rule).toBe("lens/no-async-function")
    expect(waiver.scope).toBe("file")
    expect(waiver.reason).toContain("Interop boundary")
    expect(waiver.createdBy).toBe("david")
  })

  it("requires a reason", () => {
    const bad = { ...Schema.encodeSync(Waiver.Waiver)(waiver), reason: "" }
    expect(Option.isNone(Schema.decodeUnknownOption(Waiver.Waiver)(bad))).toBe(true)
  })

  it("requires a rule id", () => {
    const bad = { ...Schema.encodeSync(Waiver.Waiver)(waiver), rule: "" }
    expect(Option.isNone(Schema.decodeUnknownOption(Waiver.Waiver)(bad))).toBe(true)
  })

  it("rejects an unknown scope", () => {
    const bad = { ...Schema.encodeSync(Waiver.Waiver)(waiver), scope: "directory" }
    expect(Option.isNone(Schema.decodeUnknownOption(Waiver.Waiver)(bad))).toBe(true)
  })

  it("serializes losslessly", () => {
    const json = Schema.encodeSync(Waiver.Waiver)(waiver)
    const decoded = Schema.decodeUnknownSync(Waiver.Waiver)(json)
    expect(Schema.encodeSync(Waiver.Waiver)(decoded)).toEqual(json)
  })
})
