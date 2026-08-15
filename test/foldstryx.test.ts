/**
 * Tests for the Foldstryx first-party rule provider and the explicit
 * Foldstryx → Lens rule-equivalence mapping.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { canonicalOf, foldstryxEquivalences, providerRuleOf } from "../src/provider/equivalence.ts"
import { foldstryxProvider } from "../src/provider/foldstryx.ts"
import { ProviderDiagnostic } from "../src/provider/Provider.ts"
import { ProviderRegistry } from "../src/provider/registry.ts"

const raw = (args: {
  code: string
  severity?: "error" | "warning"
  message?: string
  filename?: string
  line?: number
}): Parameters<typeof foldstryxProvider.normalize>[0] => {
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

describe("foldstryxEquivalences", () => {
  it("maps each supported Foldstryx rule to a canonical Lens rule", () => {
    expect(foldstryxEquivalences).toHaveLength(3)
    expect(canonicalOf("foldstryx/no-async-function")).toEqual(
      Option.some("lens/no-async-function")
    )
    expect(canonicalOf("foldstryx/no-await-expression")).toEqual(
      Option.some("lens/no-await-expression")
    )
    expect(canonicalOf("foldstryx/no-new-promise")).toEqual(
      Option.some("lens/no-new-promise")
    )
  })

  it("resolves the provider rule for a canonical Lens rule", () => {
    expect(providerRuleOf("lens/no-async-function")).toEqual(
      Option.some("foldstryx/no-async-function")
    )
  })

  it("returns none for an unsupported Foldstryx rule", () => {
    expect(Option.isNone(canonicalOf("foldstryx/no-console"))).toBe(true)
  })
})

describe("foldstryxProvider", () => {
  it("owns the supported Foldstryx rule ids", () => {
    expect(foldstryxProvider.id).toBe("foldstryx")
    expect(foldstryxProvider.ruleIds).toContain("foldstryx/no-async-function")
    expect(foldstryxProvider.ruleIds).toContain("foldstryx/no-await-expression")
    expect(foldstryxProvider.ruleIds).toContain("foldstryx/no-new-promise")
  })

  it("recognizes foldstryx codes and normalizes with foldstryx provenance mapped to the canonical Lens rule", () => {
    expect(foldstryxProvider.recognizes("foldstryx(no-async-function)")).toBe(true)
    expect(foldstryxProvider.recognizes("lens(no-async-function)")).toBe(false)
    const normalized = foldstryxProvider.normalize(
      raw({ code: "foldstryx(no-async-function)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      expect(normalized.provider).toBe("foldstryx")
      expect(Option.getOrNull(normalized.rule)).toBe("lens/no-async-function")
      expect(normalized.source).toBe("lens-strict")
      expect(normalized.evidence.length).toBeGreaterThan(0)
      expect(normalized.location.file).toBe("src/a.ts")
      expect(normalized.location.line).toBe(3)
    }
  })

  it("returns null for an unknown foldstryx code", () => {
    expect(foldstryxProvider.recognizes("foldstryx(no-console)")).toBe(false)
    expect(foldstryxProvider.normalize(raw({ code: "foldstryx(no-console)" }), 0)).toBeNull()
  })

  it("returns null for a non-foldstryx code", () => {
    expect(foldstryxProvider.normalize(raw({ code: "lens(no-async-function)" }), 0)).toBeNull()
  })
})

describe("ProviderRegistry with foldstryx", () => {
  it("resolves a foldstryx code to the foldstryx provider", () => {
    const registry = new ProviderRegistry()
    const provider = registry.findProvider("foldstryx(no-async-function)")
    expect(Option.isSome(provider)).toBe(true)
    if (Option.isSome(provider)) expect(provider.value.id).toBe("foldstryx")
  })

  it("normalizes a foldstryx code through the foldstryx provider", () => {
    const registry = new ProviderRegistry()
    const normalized = registry.normalize(raw({ code: "foldstryx(no-async-function)" }), 0)
    expect(normalized).not.toBeNull()
    if (normalized !== null) expect(normalized.provider).toBe("foldstryx")
  })

  it("round-trips a foldstryx ProviderDiagnostic through JSON", () => {
    const normalized = foldstryxProvider.normalize(
      raw({ code: "foldstryx(no-async-function)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      const json = Schema.encodeSync(ProviderDiagnostic)(normalized)
      const decoded = Schema.decodeUnknownSync(ProviderDiagnostic)(json)
      expect(decoded.provider).toBe("foldstryx")
      expect(Option.getOrNull(decoded.rule)).toBe("lens/no-async-function")
      expect(decoded.location.line).toBe(3)
    }
  })
})
