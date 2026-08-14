/**
 * Tests for the mutating `setup --apply` operation targeting `hk`.
 *
 * These exercise `applySetupPlan` against temporary project directories so no
 * committed fixture is ever mutated. They cover: applying the actionable hooks
 * step (an hk install) while deferring the dependency/oxlint steps, refusing a
 * plan that contains an unsupported step (no partial mutation), and reporting
 * already-satisfied projects.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySetupPlan } from "../src/operations/setupApply.ts"

const START_MARKER = "// === effect-lens:start ==="

/**
 * Creates a temporary project with a supported (npm) package manager, a
 * lockfile without an effect entry, no oxlint config, and an hk.pkl whose
 * `pre-commit` needs an effect-lens step. The plan has no unsupported step and
 * the hooks step needs action.
 *
 * @since 0.0.0
 */
const hkProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "effect-lens-apply-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }))
  writeFileSync(join(dir, "package-lock.json"), "{}")
  writeFileSync(
    join(dir, "hk.pkl"),
    `amends "package://github.com/jdx/hk/releases/download/v1.55.0/hk@1.55.0#/Config.pkl"\n\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["lint"] {\n        check = "pnpm lint"\n      }\n    }\n  }\n}\n`
  )
  return dir
}

describe("setup --apply", () => {
  it("applies the hooks step and defers the dependency and oxlint steps", () => {
    const dir = hkProject()
    try {
      const result = applySetupPlan({ projectDir: dir, cacheDir: join(dir, "cache") })
      expect(result.precondition).toBe(true)
      const byId = new Map(result.steps.map((s) => [s.id, s.outcome]))
      expect(byId.get("hooks")).toBe("applied")
      // Deferred, not silently skipped.
      expect(byId.get("effect-dependency")).toBe("deferred")
      expect(byId.get("oxlint-config")).toBe("deferred")
      // Already satisfied / not applicable.
      expect(byId.get("package-manager")).toBe("ok")
      expect(byId.get("reference-pack")).toBe("skipped")
      // The hk step was installed.
      const content = readFileSync(join(dir, "hk.pkl"), "utf8")
      expect(content).toContain(START_MARKER)
      expect(content).toContain("[\"effect-lens\"]")
      // Existing non-Lens step preserved.
      expect(content).toContain("[\"lint\"]")
      // No oxlint config was created.
      expect(existsSync(join(dir, ".oxlintrc.json"))).toBe(false)
      expect(existsSync(join(dir, ".oxlintrc"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports an already-configured project with no mutation", () => {
    const dir = hkProject()
    try {
      applySetupPlan({ projectDir: dir, cacheDir: join(dir, "cache") })
      const before = readFileSync(join(dir, "hk.pkl"), "utf8")
      const result = applySetupPlan({ projectDir: dir, cacheDir: join(dir, "cache") })
      const byId = new Map(result.steps.map((s) => [s.id, s.outcome]))
      // The hooks step is already satisfied, so it is reported `ok` (no mutation).
      expect(byId.get("hooks")).toBe("ok")
      const after = readFileSync(join(dir, "hk.pkl"), "utf8")
      expect(after).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a plan with an unsupported step before any mutation", () => {
    // A bun lockfile makes the package-manager step unsupported.
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-apply-bun-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }))
      writeFileSync(join(dir, "bun.lock"), "")
      writeFileSync(
        join(dir, "hk.pkl"),
        `hooks {\n  ["pre-commit"] {\n    steps {\n      ["lint"] {\n        check = "pnpm lint"\n      }\n    }\n  }\n}\n`
      )
      const result = applySetupPlan({ projectDir: dir, cacheDir: join(dir, "cache") })
      expect(result.precondition).toBe(false)
      const steps = result.steps.filter((s) => s.outcome === "refused")
      expect(steps.length).toBeGreaterThan(0)
      // No partial mutation: the hk.pkl is untouched.
      expect(readFileSync(join(dir, "hk.pkl"), "utf8")).not.toContain(START_MARKER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses when the hooks step is needed but no hk.pkl exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-apply-empty-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }))
      writeFileSync(join(dir, "package-lock.json"), "{}")
      const result = applySetupPlan({ projectDir: dir, cacheDir: join(dir, "cache") })
      expect(result.precondition).toBe(false)
      const hooks = result.steps.find((s) => s.id === "hooks")
      expect(hooks?.outcome).toBe("refused")
      // No files were created at all.
      expect(existsSync(join(dir, "hk.pkl"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
