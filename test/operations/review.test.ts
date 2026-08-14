import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import * as Review from "../../src/operations/review.ts"

const diag = (args: {
  code: string
  severity?: "error" | "warning"
  message?: string
  filename?: string
  line?: number
}): Review.OxlintDiagnostic =>
  new Review.OxlintDiagnostic({
    message: args.message ?? "message",
    code: args.code,
    severity: args.severity ?? "error",
    filename: args.filename ?? "src/a.ts",
    labels: args.line === undefined
      ? []
      : [
        new Review.OxlintLabel({
          span: Option.some(new Review.OxlintSpan({ line: args.line, column: 1 }))
        })
      ]
  })

const roundTrip = <A>(schema: Schema.Schema<A>, value: A): void => {
  const json = Schema.encodeSync(schema as any)(value)
  const decoded = Schema.decodeUnknownSync(schema as any)(json) as A
  expect(Schema.encodeSync(schema as any)(decoded)).toEqual(json)
}

describe("review", () => {
  it("maps Lens-catalog diagnostics to findings with catalog evidence", () => {
    const result = Review.review({
      input: Review.makeReviewInput({
        diagnostics: [
          diag({ code: "lens(no-async-function)", line: 14 }),
          diag({ code: "lens(no-new-promise)", line: 3 })
        ]
      })
    })
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0].rule).toBe("lens/no-async-function")
    expect(result.findings[0].location.line).toBe(14)
    expect(result.findings[0].source).toBe("lens-strict")
    expect(result.findings[0].evidence.length).toBeGreaterThan(0)
    expect(result.findings[1].rule).toBe("lens/no-new-promise")
  })

  it("distinguishes hard errors from advisory warnings in the summary", () => {
    const result = Review.review({
      input: Review.makeReviewInput({
        diagnostics: [
          diag({ code: "lens(no-async-function)", severity: "error" }),
          diag({ code: "lens(no-await-expression)", severity: "warning" })
        ]
      })
    })
    expect(result.summary.total).toBe(2)
    expect(result.summary.errors).toBe(1)
    expect(result.summary.warnings).toBe(1)
    expect(result.status).toBe(2)
  })

  it("surfaces non-catalog diagnostics as non-rule diagnostics", () => {
    const result = Review.review({
      input: Review.makeReviewInput({
        diagnostics: [diag({ code: "eslint(no-unused-vars)", severity: "warning", line: 7 })]
      })
    })
    expect(result.findings).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain("eslint(no-unused-vars)")
    expect(Option.isSome(result.diagnostics[0].location)).toBe(true)
    // Status reflects code findings only; a non-catalog diagnostic is a note.
    expect(result.status).toBe(0)
  })

  it("returns ok for an empty input", () => {
    const result = Review.review({ input: Review.makeReviewInput({ diagnostics: [] }) })
    expect(result.findings).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.summary).toEqual({ total: 0, errors: 0, warnings: 0 })
    expect(result.status).toBe(0)
  })

  it("round-trips through JSON", () => {
    const result = Review.review({
      input: Review.makeReviewInput({
        diagnostics: [
          diag({ code: "lens(no-async-function)", line: 2 }),
          diag({ code: "eslint(no-unused-vars)", severity: "warning" })
        ]
      })
    })
    roundTrip(Review.ReviewResult, result)
  })

  it("maps real oxlint JSON diagnostics through review", () => {
    const oxlint = path.resolve(process.cwd(), "node_modules/.bin/oxlint")
    const config = path.resolve(process.cwd(), "test/fixtures/rules/oxlintrc.json")
    const fixture = path.resolve(process.cwd(), "test/fixtures/rules/no-async-function.fail.ts")
    const result = spawnSync(oxlint, ["-c", config, "--format", "json", fixture], {
      encoding: "utf8"
    })
    const output = JSON.parse(result.stdout) as {
      diagnostics: Array<{
        code: string
        message: string
        severity: "error" | "warning"
        filename: string
        labels?: Array<{ span?: { line: number; column: number } }>
      }>
    }
    const input = Review.makeReviewInput({
      diagnostics: output.diagnostics.map((d) =>
        new Review.OxlintDiagnostic({
          message: d.message,
          code: d.code,
          severity: d.severity,
          filename: d.filename,
          labels: (d.labels ?? []).map((label) =>
            new Review.OxlintLabel({
              span: label.span === undefined
                ? Option.none()
                : Option.some(new Review.OxlintSpan(label.span))
            })
          )
        })
      )
    })
    const reviewed = Review.review({ input })
    expect(reviewed.findings.length).toBeGreaterThan(0)
    expect(reviewed.findings.every((f) => f.rule.startsWith("lens/"))).toBe(true)
    expect(reviewed.summary.errors).toBeGreaterThan(0)
  })
})
