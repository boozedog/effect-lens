/**
 * End-to-end tests for the mutating CLI surfaces (`setup --apply` and
 * `hooks install|uninstall`) targeting `hk`.
 *
 * These spawn the real CLI entrypoint against temporary project directories so
 * no committed fixture is ever mutated, and assert on the JSON payload shape,
 * the human output, and the exit-code contract.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ENTRY = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url))

const runCli = (args: Array<string>): { stdout: string; stderr: string; status: number } => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    encoding: "utf8"
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 }
}

/**
 * Creates a temporary hk project with a supported (npm) package manager and no
 * effect dependency, so `setup --apply` and `hooks install` are actionable.
 *
 * @since 0.0.0
 */
const hkProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "effect-lens-cli-mut-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }))
  writeFileSync(join(dir, "package-lock.json"), "{}")
  writeFileSync(
    join(dir, "hk.pkl"),
    `amends "package://github.com/jdx/hk/releases/download/v1.55.0/hk@1.55.0#/Config.pkl"\n\nhooks {\n  ["pre-commit"] {\n    steps {\n      ["lint"] {\n        check = "pnpm lint"\n      }\n    }\n  }\n}\n`
  )
  return dir
}

describe("hooks install|uninstall (CLI, hk)", () => {
  it("installs an effect-lens step and emits JSON in --json mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["hooks", "install", "--project", dir, "--json"])
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as {
        machineOutput: { status: number }
        mutation: { outcome: string; changed: boolean; manager: string | null }
      }
      expect(json.machineOutput.status).toBe(0)
      expect(json.mutation.outcome).toBe("applied")
      expect(json.mutation.changed).toBe(true)
      expect(json.mutation.manager).toBe("hk")
      expect(readFileSync(join(dir, "hk.pkl"), "utf8")).toContain("effect-lens:start")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits human output in default mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["hooks", "install", "--project", dir])
      expect(status).toBe(0)
      expect(stdout).toContain("effect-lens hooks install")
      expect(stdout).toContain("outcome: applied")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uninstall removes the step and emits JSON", () => {
    const dir = hkProject()
    try {
      runCli(["hooks", "install", "--project", dir])
      const { stdout, status } = runCli(["hooks", "uninstall", "--project", dir, "--json"])
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as { mutation: { outcome: string; changed: boolean } }
      expect(json.mutation.outcome).toBe("applied")
      expect(json.mutation.changed).toBe(true)
      expect(readFileSync(join(dir, "hk.pkl"), "utf8")).not.toContain("effect-lens:start")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("setup --apply (CLI, hk)", () => {
  it("applies the hooks step and emits JSON with per-step outcomes", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["setup", "--apply", "--project", dir, "--json"])
      expect(status).toBe(1)
      const json = JSON.parse(stdout) as {
        machineOutput: { status: number }
        apply: {
          precondition: boolean
          steps: Array<{ id: string; outcome: string }>
          hookMutation: { outcome: string }
        }
      }
      expect(json.machineOutput.status).toBe(1)
      expect(json.apply.precondition).toBe(true)
      expect(json.apply.hookMutation.outcome).toBe("applied")
      const byId = new Map(json.apply.steps.map((s) => [s.id, s.outcome]))
      expect(byId.get("hooks")).toBe("applied")
      expect(byId.get("effect-dependency")).toBe("deferred")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits human output in default mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["setup", "--apply", "--project", dir])
      expect(status).toBe(1)
      expect(stdout).toContain("effect-lens setup --apply")
      expect(stdout).toContain("[applied] hooks")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
