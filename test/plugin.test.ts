/**
 * Tests for the Lens oxlint plugin: rule diagnostics, stable rule IDs, and the
 * mapping from oxlint diagnostics to Lens {@link Finding} values.
 *
 * The rules are exercised through the real oxlint CLI against the fixture
 * files in `test/fixtures/rules/`, so parsing, scope analysis, and plugin
 * loading are all covered end-to-end.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { lensPlugin } from "../src/plugin/index.ts"
import { toFinding, toRuleId } from "../src/plugin/toFinding.ts"
import { findRule, rules } from "../src/rules/index.ts"

const OXLINT = path.resolve(process.cwd(), "node_modules/.bin/oxlint")
const CONFIG = path.resolve(process.cwd(), "test/fixtures/rules/oxlintrc.json")
const FIXTURES = path.resolve(process.cwd(), "test/fixtures/rules")

interface LensDiagnostic {
  readonly rule: string
  readonly line: number
  readonly column: number
  readonly message: string
}

const runLens = (fixture: string): Array<LensDiagnostic> => {
  const file = path.join(FIXTURES, fixture)
  const result = spawnSync(OXLINT, ["-c", CONFIG, "--format", "json", file], {
    encoding: "utf8"
  })
  const stdout = result.stdout
  const output = JSON.parse(stdout) as {
    diagnostics: Array<{
      code: string
      message: string
      labels?: Array<{ span?: { line: number; column: number } }>
    }>
  }
  return output.diagnostics
    .filter((d) => d.code.startsWith("lens("))
    .map((d) => ({
      rule: toRuleId(d.code),
      line: d.labels?.[0]?.span?.line ?? 1,
      column: d.labels?.[0]?.span?.column ?? 1,
      message: d.message
    }))
}

const expectDiagnostics = (
  fixture: string,
  expected: Array<{ rule: string; line: number }>
): void => {
  const actual = runLens(fixture)
  const actualSummary = actual.map((d) => `${d.rule}@${d.line}`)
  const expectedSummary = expected.map((d) => `${d.rule}@${d.line}`)
  expect(actualSummary, fixture).toEqual(expectedSummary)
}

describe("lens/no-async-function", () => {
  it("passes compliant fixtures", () => {
    expectDiagnostics("no-async-function.pass.ts", [])
  })

  it("flags async declarations, expressions, arrows, and methods", () => {
    expectDiagnostics("no-async-function.fail.ts", [
      { rule: "lens/no-async-function", line: 2 },
      { rule: "lens/no-async-function", line: 6 },
      { rule: "lens/no-async-function", line: 10 },
      { rule: "lens/no-async-function", line: 13 }
    ])
  })
})

describe("lens/no-await-expression", () => {
  it("passes compliant fixtures", () => {
    expectDiagnostics("no-await-expression.pass.ts", [])
  })

  it("flags await on non-bridge values", () => {
    expectDiagnostics("no-await-expression.fail.ts", [
      { rule: "lens/no-async-function", line: 2 },
      { rule: "lens/no-await-expression", line: 3 },
      { rule: "lens/no-async-function", line: 7 },
      { rule: "lens/no-await-expression", line: 8 }
    ])
  })

  it("allows the narrow bind-aware Effect.runPromise bridge", () => {
    const actual = runLens("no-await-expression.bridge.ts")
    const awaitDiags = actual.filter((d) => d.rule === "lens/no-await-expression")
    expect(awaitDiags).toEqual([])
  })

  it("allows aliased and namespace imports of the effect package", () => {
    const actual = runLens("no-await-expression.alias.ts")
    const awaitDiags = actual.filter((d) => d.rule === "lens/no-await-expression")
    expect(awaitDiags).toEqual([])
  })

  it("flags a shadowed Effect that bypasses the bridge allowlist", () => {
    expectDiagnostics("no-await-expression.shadow.ts", [
      { rule: "lens/no-async-function", line: 7 },
      { rule: "lens/no-await-expression", line: 8 }
    ])
  })
})

describe("lens/no-new-promise", () => {
  it("passes compliant fixtures", () => {
    expectDiagnostics("no-new-promise.pass.ts", [])
  })

  it("flags new Promise and new globalThis.Promise", () => {
    expectDiagnostics("no-new-promise.fail.ts", [
      { rule: "lens/no-new-promise", line: 2 },
      { rule: "lens/no-new-promise", line: 6 }
    ])
  })

  it("flags aliased Promise constructors", () => {
    expectDiagnostics("no-new-promise.alias.ts", [
      { rule: "lens/no-new-promise", line: 5 },
      { rule: "lens/no-new-promise", line: 9 }
    ])
  })

  it("flags new global.Promise", () => {
    expectDiagnostics("no-new-promise.global.ts", [
      { rule: "lens/no-new-promise", line: 2 }
    ])
  })

  it("flags a destructured Promise alias", () => {
    expectDiagnostics("no-new-promise.destructure.ts", [
      { rule: "lens/no-new-promise", line: 4 }
    ])
  })

  it("does not flag a sibling binding in the same destructure", () => {
    expectDiagnostics("no-new-promise.destructure-sibling.ts", [
      { rule: "lens/no-new-promise", line: 5 }
    ])
  })

  it("does not flag a locally-shadowed Promise class", () => {
    expectDiagnostics("no-new-promise.shadow.ts", [])
  })

  it("does not flag an alias of a locally-shadowed Promise class", () => {
    expectDiagnostics("no-new-promise.shadow-alias.ts", [])
  })
})

describe("catalog/plugin id consistency", () => {
  it("every catalog rule id maps to a plugin rule key", () => {
    for (const rule of rules) {
      const suffix = rule.id.replace(/^lens\//, "")
      expect(lensPlugin.rules[suffix], rule.id).toBeDefined()
    }
  })

  it("every plugin rule key maps to a catalog rule id", () => {
    for (const key of Object.keys(lensPlugin.rules)) {
      const id = `lens/${key}`
      expect(Option.isSome(findRule(id)), id).toBe(true)
    }
  })
})

describe("toRuleId", () => {
  it("converts any plugin(rule) code to plugin/rule", () => {
    expect(toRuleId("lens(no-async-function)")).toBe("lens/no-async-function")
    expect(toRuleId("lens(no-await-expression)")).toBe("lens/no-await-expression")
    expect(toRuleId("lens(no-new-promise)")).toBe("lens/no-new-promise")
    expect(toRuleId("eslint(no-unused-vars)")).toBe("eslint/no-unused-vars")
  })

  it("leaves codes without the plugin(rule) shape unchanged", () => {
    expect(toRuleId("plain-code")).toBe("plain-code")
  })
})

describe("toFinding", () => {
  it("maps a lens diagnostic to a Finding with catalog evidence", () => {
    const finding = toFinding(
      {
        message: "Avoid async functions",
        code: "lens(no-async-function)",
        severity: "error",
        filename: "src/service.ts",
        labels: [{ span: { line: 14, column: 3 } }]
      },
      0
    )
    expect(Option.isSome(finding)).toBe(true)
    if (Option.isSome(finding)) {
      expect(finding.value.rule).toBe("lens/no-async-function")
      expect(finding.value.severity).toBe("error")
      expect(finding.value.source).toBe("lens-strict")
      expect(finding.value.location.file).toBe("src/service.ts")
      expect(finding.value.location.line).toBe(14)
      expect(Option.isSome(finding.value.location.column)).toBe(true)
      expect(finding.value.evidence.length).toBeGreaterThan(0)
    }
  })

  it("returns none for a non-Lens diagnostic", () => {
    const finding = toFinding(
      {
        message: "unused",
        code: "eslint(no-unused-vars)",
        severity: "warning",
        filename: "src/a.ts"
      },
      0
    )
    expect(Option.isNone(finding)).toBe(true)
  })
})
