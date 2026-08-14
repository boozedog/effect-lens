/**
 * Tests for the mutating hook install/uninstall operation targeting `hk`.
 *
 * These exercise `applyHookMutation` against temporary project directories so
 * no committed fixture is ever mutated. They cover install, uninstall, repeat
 * application (idempotency), preservation of non-Lens content, the two real
 * hk.pkl step shapes (inline `steps { }` and `steps = <identifier>`), and
 * refusal of missing / unowned / malformed / unsupported configs with no
 * partial write.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyHookMutation } from "../src/operations/hookMutation.ts"

const START_MARKER = "// === effect-lens:start ==="
const END_MARKER = "// === effect-lens:end ==="

const AMENDS =
  `amends "package://github.com/jdx/hk/releases/download/v1.55.0/hk@1.55.0#/Config.pkl"`

/**
 * Creates a temporary project directory that is removed when the test ends.
 *
 * @since 0.0.0
 */
const tempProject = (): string => mkdtempSync(join(tmpdir(), "effect-lens-hk-"))

/**
 * Writes `hk.pkl` into a temp project and returns the project directory.
 *
 * @since 0.0.0
 */
const project = (body: string): string => {
  const dir = tempProject()
  writeFileSync(join(dir, "hk.pkl"), body)
  return dir
}

const read = (dir: string): string => readFileSync(join(dir, "hk.pkl"), "utf8")

/**
 * A minimal hk.pkl using an inline `steps { }` mapping under `pre-commit`.
 *
 * @since 0.0.0
 */
const inlineProject = (): string =>
  project(
    `${AMENDS}\n\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["lint"] {\n        check = "pnpm lint"\n      }\n    }\n  }\n}\n`
  )

/**
 * A minimal hk.pkl using `steps = linters` (a variable reference), the other
 * common real-world shape.
 *
 * @since 0.0.0
 */
const assignProject = (): string =>
  project(
    `${AMENDS}\n\nlocal linters = new Mapping<String, Step> {\n  ["lint"] {\n    check = "pnpm lint"\n  }\n}\n\nhooks {\n  ["pre-commit"] {\n    fix = true\n    steps = linters\n  }\n}\n`
  )

describe("hooks install (hk)", () => {
  it("inserts a Lens step into an inline steps mapping, preserving other lines", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("applied")
      expect(result.changed).toBe(true)
      expect(Option.getOrNull(result.manager)).toBe("hk")
      const content = read(dir)
      expect(content).toContain(START_MARKER)
      expect(content).toContain("[\"effect-lens\"]")
      expect(content).toContain("check = \"effect-lens check\"")
      expect(content).toContain(END_MARKER)
      expect(content).toContain("[\"lint\"]")
      expect(content.indexOf("[\"lint\"]")).toBeLessThan(content.indexOf("[\"effect-lens\"]"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("converts `steps = linters` to an inline mapping with a spread plus the Lens step", () => {
    const dir = assignProject()
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).not.toContain("steps = linters")
      expect(content).toContain("...linters")
      expect(content).toContain("[\"effect-lens\"]")
      expect(content).toContain(START_MARKER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a no-op on repeat install with no duplicate step", () => {
    const dir = inlineProject()
    try {
      expect(applyHookMutation({ projectDir: dir, operation: "install" }).outcome).toBe(
        "applied"
      )
      const second = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(second.outcome).toBe("noop")
      expect(second.changed).toBe(false)
      const count = read(dir).split("[\"effect-lens\"]").length - 1
      expect(count).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses when no hk.pkl exists", () => {
    const dir = tempProject()
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-install-hk-no-config")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses when effect-lens is referenced but not as a Lens-owned step", () => {
    const dir = project(
      `${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["effect-lens"] {\n        check = "effect-lens check"\n      }\n    }\n  }\n}\n`
    )
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("refused")
      expect(result.changed).toBe(false)
      expect(result.diagnostics.some((d) => d.id === "hooks-install-hk-not-owned")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a pre-commit without a steps mapping (no partial write)", () => {
    const dir = project(`${AMENDS}\nhooks {\n  ["pre-commit"] {\n    fix = true\n  }\n}\n`)
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-install-hk-no-steps")).toBe(true)
      // No partial write: the config is unchanged.
      expect(read(dir)).toBe(`${AMENDS}\nhooks {\n  ["pre-commit"] {\n    fix = true\n  }\n}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses an unsupported steps shape (non-simple value)", () => {
    const dir = project(`${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps = foo + bar\n  }\n}\n`)
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("refused")
      expect(
        result.diagnostics.some((d) => d.id === "hooks-install-hk-unsupported-shape")
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hooks uninstall (hk)", () => {
  it("removes the Lens step and preserves non-Lens steps", () => {
    const dir = inlineProject()
    try {
      applyHookMutation({ projectDir: dir, operation: "install" })
      const result = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).not.toContain(START_MARKER)
      expect(content).not.toContain("[\"effect-lens\"]")
      expect(content).toContain("[\"lint\"]")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a no-op when nothing is installed", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(result.outcome).toBe("noop")
      expect(result.changed).toBe(false)
      expect(read(dir)).toContain("[\"lint\"]")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("round-trips: install then uninstall returns the config to a valid state", () => {
    const dir = inlineProject()
    try {
      applyHookMutation({ projectDir: dir, operation: "install" })
      applyHookMutation({ projectDir: dir, operation: "uninstall" })
      const content = read(dir)
      expect(content).not.toContain(START_MARKER)
      expect(content).not.toContain("[\"effect-lens\"]")
      expect(content).toContain("[\"lint\"]")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a malformed (unclosed) Lens block without writing", () => {
    const dir = project(
      `${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps {\n      ${START_MARKER}\n      ["effect-lens"] {\n        check = "effect-lens check"\n      }\n    }\n  }\n}\n`
    )
    try {
      const before = read(dir)
      const result = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-uninstall-hk-malformed")).toBe(true)
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a valid pair followed by a stray start marker without corrupting the file", () => {
    const dir = project(
      `${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["lint"] {\n        check = "pnpm lint"\n      }\n      ${START_MARKER}\n      ["effect-lens"] {\n        check = "effect-lens check"\n      }\n      ${END_MARKER}\n      ${START_MARKER}\n      ["stray"] {\n        check = "stray"\n      }\n    }\n  }\n}\n`
    )
    try {
      const before = read(dir)
      const result = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-uninstall-hk-malformed")).toBe(true)
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses install when a malformed Lens block exists", () => {
    const dir = project(
      `${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps {\n      ${START_MARKER}\n    }\n  }\n}\n`
    )
    try {
      const before = read(dir)
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-install-hk-malformed")).toBe(true)
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses to uninstall an effect-lens reference that is not a Lens-owned step", () => {
    const dir = project(
      `${AMENDS}\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["effect-lens"] {\n        check = "effect-lens check"\n      }\n    }\n  }\n}\n`
    )
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(result.outcome).toBe("refused")
      expect(result.diagnostics.some((d) => d.id === "hooks-uninstall-hk-not-owned")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a no-op on repeat uninstall", () => {
    const dir = inlineProject()
    try {
      applyHookMutation({ projectDir: dir, operation: "install" })
      applyHookMutation({ projectDir: dir, operation: "uninstall" })
      const third = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(third.outcome).toBe("noop")
      expect(third.changed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
