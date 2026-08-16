/**
 * Tests for the oxlint runner failure contract and the `check` gate
 * degradation semantics (issue #17).
 *
 * These exercise `runOxlint` through its injectable spawn seam, so every
 * failure class is deterministic and offline: startup failure, non-zero empty
 * output, malformed JSON, stderr truncation, signal reporting, and valid JSON
 * diagnostics with a non-zero exit. The `check` adapter tests assert that a
 * config/plugin failure can never look like an empty clean gate and that a
 * valid non-zero lint run keeps its findings.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { check } from "../src/cli/commands/check.ts"
import { type OxlintSpawn, type OxlintSpawnResult, runOxlint } from "../src/cli/oxlint.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))

/**
 * A deterministic spawn seam that returns a fixed crafted result without
 * touching a real binary or the network.
 *
 * @since 0.1.0
 */
const fakeSpawn = (result: OxlintSpawnResult): OxlintSpawn => () => result

/**
 * A temp project dir for a run. `lens-only` mode writes its scratch config to
 * the OS temp dir, so the project dir stays untouched.
 *
 * @since 0.1.0
 */
const tempProject = (): string => mkdtempSync(join(tmpdir(), "effect-lens-oxlint-test-"))

/**
 * A valid oxlint JSON diagnostic in the shape `Review.OxlintDiagnostic`
 * decodes.
 *
 * @since 0.1.0
 */
const validJson = (): string =>
  JSON.stringify({
    diagnostics: [
      {
        message: "Do not use async functions; use Effect.gen with the sync runtime instead",
        code: "lens/no-async-function",
        severity: "error",
        filename: "src/example.ts",
        labels: [{ span: { line: 3, column: 5 } }]
      }
    ],
    number_of_files: 1
  })

describe("runOxlint failure contract", () => {
  it("reports a startup failure with the spawn error, no status and no signal", () => {
    const dir = tempProject()
    try {
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          error: new Error("spawn oxlint ENOENT")
        })
      })
      expect(run.error).toContain("oxlint failed to start: spawn oxlint ENOENT")
      expect(run.diagnostics).toHaveLength(0)
      expect(run.failure?.kind).toBe("startup")
      expect(run.failure?.status).toBeNull()
      expect(run.failure?.signal).toBeNull()
      expect(run.failure?.message).toContain("spawn oxlint ENOENT")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves exit status and a bounded stderr excerpt for non-zero empty output", () => {
    const dir = tempProject()
    try {
      const stderr =
        "error: failed to load plugin /path/to/plugin.ts\nCaused by: cannot find module"
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({ status: 2, signal: null, stdout: "", stderr })
      })
      expect(run.diagnostics).toHaveLength(0)
      expect(run.error).toContain("oxlint produced no JSON output (exit 2)")
      expect(run.error).toContain("failed to load plugin /path/to/plugin.ts")
      expect(run.failure?.kind).toBe("empty-output")
      expect(run.failure?.status).toBe(2)
      expect(run.failure?.signal).toBeNull()
      expect(run.failure?.stderr).toContain("failed to load plugin")
      expect(run.failure?.stdout).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports malformed JSON as unparseable with the exit status", () => {
    const dir = tempProject()
    try {
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({
          status: 1,
          signal: null,
          stdout: "{ this is not json",
          stderr: ""
        })
      })
      expect(run.error).toContain("oxlint produced unparseable output (exit 1)")
      expect(run.failure?.kind).toBe("unparseable")
      expect(run.failure?.status).toBe(1)
      expect(run.diagnostics).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("bounds a chatty stderr excerpt with an explicit truncation marker", () => {
    const dir = tempProject()
    try {
      const chatty = "config/plugin noise\n".repeat(400)
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({ status: 1, signal: null, stdout: "", stderr: chatty })
      })
      expect(run.failure?.kind).toBe("empty-output")
      expect(run.failure?.stderr).not.toBeNull()
      expect(run.failure?.stderr?.length).toBeLessThan(chatty.length)
      expect(run.failure?.stderr).toContain("more characters truncated")
      // The human message is bounded too: it embeds the same excerpt.
      expect(run.error?.length).toBeLessThan(chatty.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a terminating signal when the subprocess was killed", () => {
    const dir = tempProject()
    try {
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })
      })
      expect(run.error).toContain("oxlint produced no JSON output (killed by SIGKILL)")
      expect(run.failure?.kind).toBe("empty-output")
      expect(run.failure?.signal).toBe("SIGKILL")
      expect(run.failure?.status).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("surfaces the real oxlint stdout-only plugin failure signature (1.78)", () => {
    const dir = tempProject()
    try {
      // oxlint 1.78 prints plugin/config load failures to stdout and leaves
      // stderr empty: exit 1, no `{` in stdout. The cause must surface.
      const stdout = "Failed to parse oxlint configuration file.\n\n" +
        "  x Failed to load JS plugin: ./missing-plugin.ts\n" +
        "  |   Cannot find module './missing-plugin.ts'\n"
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({ status: 1, signal: null, stdout, stderr: "" })
      })
      expect(run.error).toContain("oxlint produced no JSON output (exit 1)")
      expect(run.error).toContain("Failed to load JS plugin: ./missing-plugin.ts")
      expect(run.error).toContain("Cannot find module")
      expect(run.failure?.kind).toBe("empty-output")
      expect(run.failure?.stderr).toBe("")
      expect(run.failure?.stdout).toContain("Failed to load JS plugin")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a present-but-non-array diagnostics value as unparseable", () => {
    const dir = tempProject()
    try {
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({
          status: 1,
          signal: null,
          stdout: JSON.stringify({ diagnostics: {} }),
          stderr: ""
        })
      })
      expect(run.failure?.kind).toBe("unparseable")
      expect(run.error).toContain("diagnostics is not an array")
      expect(run.diagnostics).toHaveLength(0)
      expect(run.files).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps valid JSON diagnostics as normal findings even when oxlint exits non-zero", () => {
    const dir = tempProject()
    try {
      const run = runOxlint({
        projectDir: dir,
        targets: ["src"],
        spawn: fakeSpawn({ status: 2, signal: null, stdout: validJson(), stderr: "" })
      })
      expect(run.error).toBeNull()
      expect(run.failure).toBeNull()
      expect(run.files).toBe(1)
      expect(run.diagnostics).toHaveLength(1)
      expect(run.diagnostics[0]?.code).toBe("lens/no-async-function")
      expect(run.diagnostics[0]?.severity).toBe("error")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("check gate degradation contract", () => {
  it("reports a config/plugin failure as an unavailable gate, never a clean one", () => {
    const dir = tempProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        spawn: fakeSpawn({
          status: 1,
          signal: null,
          stdout: "",
          stderr: "error: failed to load plugin /path/to/plugin.ts"
        })
      })
      expect(result.machineOutput.status).toBe(1) // warning, not clean ok
      const unavailable = result.machineOutput.diagnostics.find(
        (d) => d.id === "check-oxlint-unavailable"
      )
      expect(unavailable).toBeDefined()
      expect(unavailable?.severity).toBe("warning")
      expect(unavailable?.message).toContain("exit 1")
      expect(unavailable?.message).toContain("failed to load plugin")
      const oxlint = (result.json as {
        oxlint: {
          error: string | null
          failure: { kind: string; status: number | null; stderr: string | null } | null
        }
      }).oxlint
      expect(oxlint.error).toContain("no JSON output")
      expect(oxlint.failure?.kind).toBe("empty-output")
      expect(oxlint.failure?.status).toBe(1)
      expect(oxlint.failure?.stderr).toContain("failed to load plugin")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps valid non-zero JSON diagnostics as gate findings, not a tool error", () => {
    const dir = tempProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        spawn: fakeSpawn({ status: 2, signal: null, stdout: validJson(), stderr: "" })
      })
      // The finding drives an error status (2); the gate is NOT marked
      // unavailable and no oxlint failure metadata is present.
      expect(result.machineOutput.status).toBe(2)
      expect(result.machineOutput.findings.length).toBeGreaterThan(0)
      expect(
        result.machineOutput.diagnostics.some((d) => d.id === "check-oxlint-unavailable")
      ).toBe(false)
      const oxlint = (result.json as { oxlint: { error: string | null; failure: unknown } })
        .oxlint
      expect(oxlint.error).toBeNull()
      expect(oxlint.failure).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("surfaces the stdout-only plugin failure cause in the check diagnostic", () => {
    const dir = tempProject()
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        spawn: fakeSpawn({
          status: 1,
          signal: null,
          stdout: "Failed to load JS plugin: ./missing-plugin.ts\nCannot find module\n",
          stderr: ""
        })
      })
      expect(result.machineOutput.status).toBe(1) // warning, not clean ok
      const unavailable = result.machineOutput.diagnostics.find(
        (d) => d.id === "check-oxlint-unavailable"
      )
      expect(unavailable).toBeDefined()
      expect(unavailable?.message).toContain("exit 1")
      expect(unavailable?.message).toContain("Failed to load JS plugin")
      expect(unavailable?.message).toContain("Cannot find module")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a real unified run with a missing plugin as unavailable with the cause (integration)", () => {
    const dir = tempProject()
    try {
      writeFileSync(
        join(dir, ".oxlintrc.json"),
        JSON.stringify({ jsPlugins: ["./missing-plugin.ts"] })
      )
      writeFileSync(join(dir, "a.ts"), "const x = 1\n")
      const result = check({ projectDir: dir, cacheDir, mode: "unified" })
      // Real oxlint 1.78: exit 1, cause on stdout, empty stderr. The gate must
      // be unavailable — never clean — and the cause must be in the message.
      expect(result.machineOutput.status).toBe(1)
      const unavailable = result.machineOutput.diagnostics.find(
        (d) => d.id === "check-oxlint-unavailable"
      )
      expect(unavailable).toBeDefined()
      expect(unavailable?.message).toContain("exit 1")
      expect(unavailable?.message).toContain("Failed to load JS plugin")
      expect(unavailable?.message).not.toBe("oxlint produced no JSON output (exit 1)")
      const oxlint = (result.json as {
        oxlint: { error: string | null; failure: { stdout: string | null } | null }
      }).oxlint
      expect(oxlint.failure?.stdout).toContain("Failed to load JS plugin")
      // Read-only: the transient unified config is removed by the finally block.
      const leftovers = readdirSync(dir).filter((f) => f.startsWith(".effect-lens-check-oxlintrc-"))
      expect(leftovers).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
