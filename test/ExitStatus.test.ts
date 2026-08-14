import { describe, expect, it } from "@effect/vitest"
import * as ExitStatus from "../src/ExitStatus.ts"
import * as Finding from "../src/Finding.ts"

const finding = (severity: "warning" | "error") =>
  Finding.makeFinding({
    id: `f-${severity}`,
    rule: "lens/no-async-function",
    severity,
    source: "lens-strict",
    message: "msg",
    location: Finding.makeLocation({ file: "a.ts", line: 1 }),
    evidence: []
  })

const diagnostic = (severity: "warning" | "error") => ({
  id: `d-${severity}`,
  severity,
  message: "diag"
})

describe("aggregateStatus", () => {
  it("returns Ok with no findings or diagnostics", () => {
    expect(ExitStatus.aggregateStatus({ findings: [], diagnostics: [] })).toBe(ExitStatus.Exit.Ok)
  })

  it("returns Warning for a warning finding", () => {
    expect(
      ExitStatus.aggregateStatus({ findings: [finding("warning")], diagnostics: [] })
    ).toBe(ExitStatus.Exit.Warning)
  })

  it("returns Error for an error finding", () => {
    expect(
      ExitStatus.aggregateStatus({ findings: [finding("error")], diagnostics: [] })
    ).toBe(ExitStatus.Exit.Error)
  })

  it("error dominates warning", () => {
    expect(
      ExitStatus.aggregateStatus({
        findings: [finding("warning"), finding("error")],
        diagnostics: []
      })
    ).toBe(ExitStatus.Exit.Error)
  })

  it("an error diagnostic alone returns Error", () => {
    expect(
      ExitStatus.aggregateStatus({ findings: [], diagnostics: [diagnostic("error") as any] })
    ).toBe(ExitStatus.Exit.Error)
  })
})
