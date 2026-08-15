/**
 * Tests for the rule provider seam: provider identity, normalized diagnostic
 * provenance, and the provider registry.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { lensProvider } from "../src/provider/lens.ts"
import { ProviderDiagnostic } from "../src/provider/Provider.ts"
import { ProviderRegistry } from "../src/provider/registry.ts"

const raw = (args: {
  code: string
  severity?: "error" | "warning"
  message?: string
  filename?: string
  line?: number
}): Parameters<typeof lensProvider.normalize>[0] => {
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

describe("lensProvider", () => {
  it("owns the Lens rule catalog ids", () => {
    expect(lensProvider.id).toBe("lens")
    expect(lensProvider.ruleIds).toContain("lens/no-async-function")
    expect(lensProvider.ruleIds).toContain("lens/no-await-expression")
    expect(lensProvider.ruleIds).toContain("lens/no-new-promise")
  })

  it("recognizes lens codes and normalizes with lens provenance", () => {
    expect(lensProvider.recognizes("lens(no-async-function)")).toBe(true)
    expect(lensProvider.recognizes("eslint(no-console)")).toBe(false)
    const normalized = lensProvider.normalize(
      raw({ code: "lens(no-async-function)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      expect(normalized.provider).toBe("lens")
      expect(Option.getOrNull(normalized.rule)).toBe("lens/no-async-function")
      expect(normalized.severity).toBe("error")
      expect(normalized.location.file).toBe("src/a.ts")
      expect(normalized.location.line).toBe(3)
    }
  })

  it("returns null for a non-lens code", () => {
    const normalized = lensProvider.normalize(
      raw({ code: "eslint(no-unused-vars)", severity: "warning" }),
      0
    )
    expect(normalized).toBeNull()
  })
})

describe("ProviderRegistry", () => {
  it("resolves the lens provider for a lens code", () => {
    const registry = new ProviderRegistry()
    const provider = registry.findProvider("lens(no-async-function)")
    expect(Option.isSome(provider)).toBe(true)
    if (Option.isSome(provider)) expect(provider.value.id).toBe("lens")
  })

  it("returns none for an unrecognized code", () => {
    const registry = new ProviderRegistry()
    expect(Option.isNone(registry.findProvider("eslint(no-console)"))).toBe(true)
  })

  it("normalizes through the first matching provider", () => {
    const registry = new ProviderRegistry()
    const normalized = registry.normalize(raw({ code: "lens(no-async-function)" }), 0)
    expect(normalized).not.toBeNull()
    if (normalized !== null) expect(normalized.provider).toBe("lens")
  })

  it("returns null when no provider recognizes the diagnostic", () => {
    const registry = new ProviderRegistry()
    const normalized = registry.normalize(raw({ code: "eslint(no-unused-vars)" }), 0)
    expect(normalized).toBeNull()
  })

  it("round-trips a ProviderDiagnostic through JSON", () => {
    const normalized = lensProvider.normalize(
      raw({ code: "lens(no-async-function)", line: 3 }),
      0
    )
    expect(normalized).not.toBeNull()
    if (normalized !== null) {
      const json = Schema.encodeSync(ProviderDiagnostic)(normalized)
      const decoded = Schema.decodeUnknownSync(ProviderDiagnostic)(json)
      expect(decoded.provider).toBe("lens")
      expect(Option.getOrNull(decoded.rule)).toBe("lens/no-async-function")
      expect(decoded.location.line).toBe(3)
    }
  })
})
