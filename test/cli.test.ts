/**
 * End-to-end tests for the Effect Lens CLI process.
 *
 * These spawn the real CLI entrypoint and assert on stdout/stderr and the
 * process exit code, covering argument parsing, dispatch, JSON mode, and the
 * exact `0`/`1`/`2` exit-code contract.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const ENTRY = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url))

const runCli = (args: Array<string>): { stdout: string; stderr: string; status: number } => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    encoding: "utf8",
    cwd: repoRoot
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 }
}

const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))
const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))

describe("CLI dispatch", () => {
  it("exits 2 for an unknown command", () => {
    const { stderr, status } = runCli(["bogus"])
    expect(status).toBe(2)
    expect(stderr).toContain("unknown command: bogus")
  })

  it("exits 2 when no command is given", () => {
    const { stderr, status } = runCli([])
    expect(status).toBe(2)
    expect(stderr).toContain("missing command")
  })

  it("prints usage for --help and exits 0", () => {
    const { stdout, status } = runCli(["--help"])
    expect(status).toBe(0)
    expect(stdout).toContain("Usage: effect-lens <command>")
    expect(stdout).toContain("freshness")
  })

  it("prints the version for --version and exits 0", () => {
    const { stdout, status } = runCli(["--version"])
    expect(status).toBe(0)
    expect(stdout).toContain("effect-lens 0.1.0")
  })

  it("strips a leading -- separator (pnpm passes one before script args)", () => {
    const { stdout, status } = runCli([
      "--",
      "doctor",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir
    ])
    expect(status).toBe(0)
    expect(stdout).toContain("effect-lens doctor")
  })
})

describe("CLI doctor", () => {
  it("exits 0 for a resolved project in human mode", () => {
    const { stdout, status } = runCli([
      "doctor",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir
    ])
    expect(status).toBe(0)
    expect(stdout).toContain("effect-lens doctor")
  })

  it("exits 2 for a missing dependency", () => {
    const { status } = runCli([
      "doctor",
      "--project",
      project("missing-dependency"),
      "--cache",
      cacheDir
    ])
    expect(status).toBe(2)
  })

  it("emits parseable JSON with the machine output in --json mode", () => {
    const { stdout, status } = runCli([
      "doctor",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(0)
    const json = JSON.parse(stdout) as { machineOutput: { status: number } }
    expect(json.machineOutput.status).toBe(0)
  })
})

describe("CLI drift", () => {
  it("exits 0 for a compatible project and emits a drift report in JSON mode", () => {
    const { stdout, status } = runCli([
      "drift",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(0)
    const json = JSON.parse(stdout) as { report: { entries: Array<{ kind: string }> } }
    expect(json.report.entries.length).toBeGreaterThan(0)
  })
})

describe("CLI check", () => {
  it("exits 2 for a failing fixture and emits findings in JSON mode", () => {
    const { stdout, status } = runCli([
      "check",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir,
      "--path",
      "../../rules/no-async-function.fail.ts",
      "--json"
    ])
    expect(status).toBe(2)
    const json = JSON.parse(stdout) as {
      machineOutput: { status: number; findings: Array<unknown> }
    }
    expect(json.machineOutput.status).toBe(2)
    expect(json.machineOutput.findings.length).toBeGreaterThan(0)
  })

  it("exits 2 for an invalid --mode value", () => {
    const { stderr, status } = runCli([
      "check",
      "--project",
      project("check-unified"),
      "--cache",
      cacheDir,
      "--mode",
      "unify"
    ])
    expect(status).toBe(2)
    expect(stderr).toContain("invalid --mode")
  })

  it("accepts --mode unified and reports the mode and config source in JSON", () => {
    const { stdout, status } = runCli([
      "check",
      "--project",
      project("check-unified"),
      "--cache",
      cacheDir,
      "--mode",
      "unified",
      "--json"
    ])
    expect(status).toBe(2)
    const json = JSON.parse(stdout) as { oxlint: { mode: string; config: string } }
    expect(json.oxlint.mode).toBe("unified")
    expect(json.oxlint.config).toBe("project")
  })
})

describe("CLI setup", () => {
  it("exits 2 when setup is run without an explicit mode", () => {
    const { stderr, status } = runCli(["setup", "--project", project("npm-valid")])
    expect(status).toBe(2)
    expect(stderr).toContain("setup requires an explicit mode")
  })

  it("exits 2 when setup is run with both --dry-run and --apply", () => {
    const { stderr, status } = runCli([
      "setup",
      "--dry-run",
      "--apply",
      "--project",
      project("npm-valid")
    ])
    expect(status).toBe(2)
    expect(stderr).toContain("mutually exclusive")
  })

  it("exits 1 for a project needing setup and emits a plan in JSON mode", () => {
    const { stdout, status } = runCli([
      "setup",
      "--dry-run",
      "--project",
      project("npm-valid"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(1)
    const json = JSON.parse(stdout) as {
      machineOutput: { status: number }
      plan: { steps: Array<{ id: string; status: string }> }
    }
    expect(json.machineOutput.status).toBe(1)
    expect(json.plan.steps.length).toBeGreaterThan(0)
  })

  it("exits 2 for an unsupported package manager", () => {
    const { status } = runCli([
      "setup",
      "--dry-run",
      "--project",
      project("bun-lockfile"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(2)
  })
})

describe("CLI hooks", () => {
  it("exits 2 when hooks is run without a subcommand", () => {
    const { stderr, status } = runCli(["hooks", "--project", project("npm-valid")])
    expect(status).toBe(2)
    expect(stderr).toContain("unknown hooks subcommand")
  })

  it("exits 2 for hooks install when no hk config is detected", () => {
    const { stdout, status } = runCli([
      "hooks",
      "install",
      "--project",
      project("npm-valid")
    ])
    expect(status).toBe(2)
    expect(stdout).toContain("no hk.pkl found")
  })

  it("exits 0 for hooks uninstall when nothing is installed (idempotent)", () => {
    const { stdout, status } = runCli([
      "hooks",
      "uninstall",
      "--project",
      project("npm-valid")
    ])
    expect(status).toBe(0)
    expect(stdout).toContain("no hk.pkl config; nothing is installed")
  })

  it("exits 0 for a project with lens hooks installed", () => {
    const { stdout, status } = runCli([
      "hooks",
      "status",
      "--project",
      project("hooks-husky-installed"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(0)
    const json = JSON.parse(stdout) as { hooks: { lensStatus: string } }
    expect(json.hooks.lensStatus).toBe("installed")
  })

  it("exits 1 for a project with no hook manager", () => {
    const { status } = runCli([
      "hooks",
      "status",
      "--project",
      project("hooks-clean"),
      "--cache",
      cacheDir,
      "--json"
    ])
    expect(status).toBe(1)
  })
})
