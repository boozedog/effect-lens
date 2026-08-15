/**
 * Tests for the StyleX first-party rule provider and its explicit supported
 * StyleX rule catalog.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ProviderDiagnostic } from "../src/provider/Provider.ts"
import { ProviderRegistry } from "../src/provider/registry.ts"
import { stylexProvider, stylexRuleIds } from "../src/provider/stylex.ts"

const raw = (args: {
  code: string
  severity?: "error" | "warning"
  message?: string
  filename?: string
  line?: number
}): Parameters<typeof stylexProvider.normalize>[0] => {
  const base = {
    message: args.message ?? "message",
    code: args.code,
    severity: args.severity ?? "error",
    filename: args.filename ?? "src/a.ts"
  }
  return args.line === undefined
    ? base
    : { ...base, labels: [{ span: { line: args.line, column: 1 } }] }
}

describe("stylexRuleIds", () => {
  it("owns exactly the explicit supported StyleX rule catalog", () => {
    expect(stylexRuleIds).toEqual([
      "stylex/valid-styles",
      "stylex/valid-shorthands",
      "stylex/no-unused",
      "stylex/no-legacy-contextual-styles",
      "stylex/no-conflicting-props",
      "stylex/no-nonstandard-styles",
      "stylex/no-lookahead-selectors",
      "stylex/sort-keys",
      "stylex/enforce-extension"
    ])
  })
})

describe("stylexProvider", () => {
  it("owns the supported StyleX rule ids", () => {
    expect(stylexProvider.id).toBe("stylex")
    expect(stylexProvider.ruleIds).toEqual(stylexRuleIds)
  })

  it("recognizes supported stylex codes and normalizes with stylex provenance and project source", () => {
    expect(stylexProvider.recognizes("stylex(valid-styles)")).toBe(true)
    expect(stylexProvider.recognizes("stylex(no-unused)")).toBe(true)
    expect(stylexProvider.recognizes("lens(no-async-function)")).toBe(false)
    const normalized = stylexProvider.normalize(
      raw({ code: "stylex(valid-styles)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      expect(normalized.provider).toBe("stylex")
      expect(Option.getOrNull(normalized.rule)).toBe("stylex/valid-styles")
      // StyleX rules are project rules, never upstream Effect guidance or
      // Lens strict policy.
      expect(normalized.source).toBe("project")
      expect(normalized.evidence.length).toBeGreaterThan(0)
      expect(normalized.location.file).toBe("src/a.ts")
      expect(normalized.location.line).toBe(3)
    }
  })

  it("preserves a warning severity", () => {
    const normalized = stylexProvider.normalize(
      raw({ code: "stylex(sort-keys)", severity: "warning", line: 5 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) expect(normalized.severity).toBe("warning")
  })

  it("returns null for an unsupported stylex code", () => {
    expect(stylexProvider.recognizes("stylex/no-such-rule")).toBe(false)
    expect(stylexProvider.normalize(raw({ code: "stylex(no-such-rule)" }), 0)).toBeNull()
  })

  it("returns null for a non-stylex code", () => {
    expect(stylexProvider.normalize(raw({ code: "lens(no-async-function)" }), 0)).toBeNull()
    expect(stylexProvider.normalize(raw({ code: "foldstryx(no-async-function)" }), 0)).toBeNull()
  })
})

describe("ProviderRegistry with stylex", () => {
  it("resolves a stylex code to the stylex provider", () => {
    const registry = new ProviderRegistry()
    const provider = registry.findProvider("stylex(valid-styles)")
    expect(Option.isSome(provider)).toBe(true)
    if (Option.isSome(provider)) expect(provider.value.id).toBe("stylex")
  })

  it("normalizes a stylex code through the stylex provider", () => {
    const registry = new ProviderRegistry()
    const normalized = registry.normalize(raw({ code: "stylex(no-unused)" }), 0)
    expect(normalized).not.toBeNull()
    if (normalized !== null) expect(normalized.provider).toBe("stylex")
  })

  it("round-trips a stylex ProviderDiagnostic through JSON", () => {
    const normalized = stylexProvider.normalize(
      raw({ code: "stylex(valid-styles)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      const json = Schema.encodeSync(ProviderDiagnostic)(normalized)
      const decoded = Schema.decodeUnknownSync(ProviderDiagnostic)(json)
      expect(decoded.provider).toBe("stylex")
      expect(Option.getOrNull(decoded.rule)).toBe("stylex/valid-styles")
      expect(decoded.source).toBe("project")
      expect(decoded.location.line).toBe(3)
    }
  })
})
