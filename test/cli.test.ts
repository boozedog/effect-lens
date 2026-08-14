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
  })

  it("prints the version for --version and exits 0", () => {
    const { stdout, status } = runCli(["--version"])
    expect(status).toBe(0)
    expect(stdout).toContain("effect-lens 0.0.0")
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
})
