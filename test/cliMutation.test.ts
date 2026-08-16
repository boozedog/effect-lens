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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ENTRY = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url))

/**
 * A fake `effect-lens` executable placed on PATH so the CLI's command-
 * availability precondition passes without depending on the real binary or a
 * built `dist/`. The generated hk step embeds the literal `effect-lens` name
 * (the default command), so CLI tests assert the realistic command text.
 *
 * @since 0.0.0
 */
let fakeBinEnv: NodeJS.ProcessEnv | null = null
const binEnv = (): NodeJS.ProcessEnv => {
  if (fakeBinEnv === null) {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-cli-bin-"))
    const bin = join(dir, "effect-lens")
    writeFileSync(bin, "#!/bin/sh\nexit 0\n")
    chmodSync(bin, 0o755)
    fakeBinEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }
  }
  return fakeBinEnv
}

const runCli = (
  args: Array<string>,
  env?: NodeJS.ProcessEnv
): { stdout: string; stderr: string; status: number } => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    encoding: "utf8",
    ...(env === undefined ? {} : { env })
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

/**
 * Creates a temporary catalog directory with a single `pack-effect-109` entry
 * whose `sourceUrl` points at a temporary source directory containing the
 * included files plus a matching `manifest.json`. Returns the catalog dir.
 *
 * @since 0.0.0
 */
const packFixture = (): { catalogDir: string; cacheDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "effect-lens-packs-"))
  const catalogDir = join(root, "catalog")
  const sourceDir = join(root, "source")
  const cacheDir = join(root, "cache")
  mkdirSync(join(catalogDir, "pack-effect-109"), { recursive: true })
  mkdirSync(join(sourceDir, "ai-docs"), { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(sourceDir, "LLMS.md"), "# Effect")
  writeFileSync(join(sourceDir, "ai-docs", "guide.md"), "guide")
  const manifest = {
    id: "pack-effect-109",
    effectVersion: "4.0.0-rc.109",
    packageIdentity: {
      name: "effect",
      version: "4.0.0-rc.109",
      source: "lockfile",
      integrity: null
    },
    upstream: {
      repository: "effect-ts/effect",
      ref: "v4.0.0-rc.109",
      commit: "deadbeef",
      sourceUrl: null
    },
    includedPaths: ["LLMS.md", "ai-docs/guide.md"],
    sourceUrl: null,
    integrity: null,
    attribution: null,
    status: "complete"
  }
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify(manifest))
  writeFileSync(
    join(catalogDir, "pack-effect-109", "manifest.json"),
    JSON.stringify({ ...manifest, sourceUrl: `file://${sourceDir}` })
  )
  return { catalogDir, cacheDir }
}

describe("hooks install|uninstall (CLI, hk)", () => {
  it("installs an effect-lens step and emits JSON in --json mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["hooks", "install", "--project", dir, "--json"], binEnv())
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as {
        machineOutput: { status: number }
        mutation: { outcome: string; changed: boolean; manager: string | null }
      }
      expect(json.machineOutput.status).toBe(0)
      expect(json.mutation.outcome).toBe("applied")
      expect(json.mutation.changed).toBe(true)
      expect(json.mutation.manager).toBe("hk")
      const content = readFileSync(join(dir, "hk.pkl"), "utf8")
      expect(content).toContain("effect-lens:start")
      // The generated step is the scoped unified changed-file gate.
      expect(content).toContain("check --mode unified --changed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits human output in default mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["hooks", "install", "--project", dir], binEnv())
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
      runCli(["hooks", "install", "--project", dir], binEnv())
      const { stdout, status } = runCli(
        ["hooks", "uninstall", "--project", dir, "--json"],
        binEnv()
      )
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as { mutation: { outcome: string; changed: boolean } }
      expect(json.mutation.outcome).toBe("applied")
      expect(json.mutation.changed).toBe(true)
      expect(readFileSync(join(dir, "hk.pkl"), "utf8")).not.toContain("effect-lens:start")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes an explicitly selected workspace into the generated command", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(
        ["hooks", "install", "--project", dir, "--workspace", "packages/foldkit", "--json"],
        binEnv()
      )
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as { mutation: { outcome: string } }
      expect(json.mutation.outcome).toBe("applied")
      const content = readFileSync(join(dir, "hk.pkl"), "utf8")
      expect(content).toContain("check --mode unified --changed")
      expect(content).toContain("--workspace 'packages/foldkit'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses install when the effect-lens command is unavailable", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["hooks", "install", "--project", dir, "--json"], {
        ...binEnv(),
        EFFECT_LENS_COMMAND: "/nonexistent/effect-lens"
      })
      expect(status).toBe(2)
      const json = JSON.parse(stdout) as {
        mutation: { outcome: string; changed: boolean }
        machineOutput: { diagnostics: Array<{ id: string }> }
      }
      expect(json.mutation.outcome).toBe("refused")
      expect(json.mutation.changed).toBe(false)
      expect(
        json.machineOutput.diagnostics.some((d) => d.id === "hooks-install-hk-command-unavailable")
      ).toBe(true)
      // No partial write.
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
      const { stdout, status } = runCli(["setup", "--apply", "--project", dir, "--json"], binEnv())
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
      // The generated step is the scoped unified changed-file gate.
      expect(readFileSync(join(dir, "hk.pkl"), "utf8")).toContain("check --mode unified --changed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits human output in default mode", () => {
    const dir = hkProject()
    try {
      const { stdout, status } = runCli(["setup", "--apply", "--project", dir], binEnv())
      expect(status).toBe(1)
      expect(stdout).toContain("effect-lens setup --apply")
      expect(stdout).toContain("[applied] hooks")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("packs fetch (CLI)", () => {
  it("fetches an exact pack and emits JSON with exit 0", () => {
    const { catalogDir, cacheDir } = packFixture()
    try {
      const { stdout, status } = runCli([
        "packs",
        "fetch",
        "--project",
        catalogDir,
        "--cache",
        cacheDir,
        "--catalog",
        catalogDir,
        "--id",
        "pack-effect-109",
        "--json"
      ])
      expect(status).toBe(0)
      const json = JSON.parse(stdout) as {
        machineOutput: { status: number }
        acquire: { action: string }
      }
      expect(json.machineOutput.status).toBe(0)
      expect(json.acquire.action).toBe("acquired")
      expect(existsSync(join(cacheDir, "pack-effect-109", "manifest.json"))).toBe(true)
    } finally {
      rmSync(dirname(catalogDir), { recursive: true, force: true })
    }
  })

  it("exits 2 when --catalog or --id is missing", () => {
    const { catalogDir, cacheDir } = packFixture()
    try {
      const missingCatalog = runCli([
        "packs",
        "fetch",
        "--project",
        catalogDir,
        "--cache",
        cacheDir,
        "--id",
        "pack-effect-109"
      ])
      expect(missingCatalog.status).toBe(2)
      expect(missingCatalog.stderr).toContain("packs fetch requires --catalog")
      const missingId = runCli([
        "packs",
        "fetch",
        "--project",
        catalogDir,
        "--cache",
        cacheDir,
        "--catalog",
        catalogDir
      ])
      expect(missingId.status).toBe(2)
      expect(missingId.stderr).toContain("packs fetch requires --catalog <dir> and --id <pack-id>")
    } finally {
      rmSync(dirname(catalogDir), { recursive: true, force: true })
    }
  })
})
