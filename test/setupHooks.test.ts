/**
 * Unit tests for the `setup --dry-run` and `hooks status` CLI commands.
 *
 * These exercise the adapters directly against the shared-core fixtures,
 * asserting the {@link MachineOutput} status (which drives the exit code), the
 * JSON payload shape, and the read-only guarantee (no project files change).
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { hooks } from "../src/cli/commands/hooks.ts"
import { setup } from "../src/cli/commands/setup.ts"
import type { CliResult } from "../src/cli/types.ts"

const project = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/projects/${name}`, import.meta.url))
const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))

interface HooksJson {
  machineOutput: { status: number }
  hooks: {
    lensStatus: string
    managers: Array<{ manager: string; present: boolean; lensStatus: string }>
  }
}

interface SetupJson {
  machineOutput: { status: number }
  plan: {
    packageManager: string | null
    oxlint: { status: string }
    steps: Array<{ id: string; status: string }>
  }
}

const hooksJson = (result: CliResult): HooksJson => result.json as HooksJson
const setupJson = (result: CliResult): SetupJson => result.json as SetupJson

/**
 * Recursively snapshots a directory's file paths and contents so a test can
 * prove a command changed no project files.
 *
 * @since 0.0.0
 */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        out[path] = readFileSync(path, "utf8")
      }
    }
  }
  walk(dir)
  return out
}

describe("hooks status", () => {
  it("reports a clean project with no hook manager as absent", () => {
    const result = hooks({ projectDir: project("hooks-clean"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(hooksJson(result).hooks.lensStatus).toBe("absent")
    expect(hooksJson(result).hooks.managers).toHaveLength(6)
    expect(hooksJson(result).hooks.managers.every((m) => m.present === false)).toBe(true)
  })

  it("reports husky with an effect-lens pre-commit as installed", () => {
    const result = hooks({ projectDir: project("hooks-husky-installed"), cacheDir })
    expect(result.machineOutput.status).toBe(0)
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const husky = hooksJson(result).hooks.managers.find((m) => m.manager === "husky")
    expect(husky?.present).toBe(true)
    expect(husky?.lensStatus).toBe("installed")
  })

  it("reports husky without an effect-lens pre-commit as absent", () => {
    const result = hooks({ projectDir: project("hooks-husky-absent"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(hooksJson(result).hooks.lensStatus).toBe("absent")
    const husky = hooksJson(result).hooks.managers.find((m) => m.manager === "husky")
    expect(husky?.present).toBe(true)
    expect(husky?.lensStatus).toBe("absent")
  })

  it("reports lefthook with an effect-lens config as installed", () => {
    const result = hooks({ projectDir: project("hooks-lefthook-installed"), cacheDir })
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const lefthook = hooksJson(result).hooks.managers.find((m) => m.manager === "lefthook")
    expect(lefthook?.lensStatus).toBe("installed")
  })

  it("reports pre-commit with an effect-lens config as installed", () => {
    const result = hooks({ projectDir: project("hooks-precommit-installed"), cacheDir })
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const preCommit = hooksJson(result).hooks.managers.find((m) => m.manager === "pre-commit")
    expect(preCommit?.lensStatus).toBe("installed")
  })

  it("reports lint-staged with an effect-lens config as installed", () => {
    const result = hooks({ projectDir: project("hooks-lint-staged-installed"), cacheDir })
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const lintStaged = hooksJson(result).hooks.managers.find((m) => m.manager === "lint-staged")
    expect(lintStaged?.lensStatus).toBe("installed")
  })

  it("reports simple-git-hooks with an effect-lens config as installed", () => {
    const result = hooks({ projectDir: project("hooks-simple-git-hooks-installed"), cacheDir })
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const sgh = hooksJson(result).hooks.managers.find((m) => m.manager === "simple-git-hooks")
    expect(sgh?.lensStatus).toBe("installed")
  })

  it("reports hk with an effect-lens step as installed", () => {
    const result = hooks({ projectDir: project("hooks-hk-installed"), cacheDir })
    expect(result.machineOutput.status).toBe(0)
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const hk = hooksJson(result).hooks.managers.find((m) => m.manager === "hk")
    expect(hk?.present).toBe(true)
    expect(hk?.lensStatus).toBe("installed")
  })

  it("reports an hk config without effect-lens as absent", () => {
    const result = hooks({ projectDir: project("hooks-hk-absent"), cacheDir })
    expect(hooksJson(result).hooks.lensStatus).toBe("absent")
    const hk = hooksJson(result).hooks.managers.find((m) => m.manager === "hk")
    expect(hk?.present).toBe(true)
    expect(hk?.lensStatus).toBe("absent")
  })

  it("reports an unreadable hook config as ambiguous", () => {
    const result = hooks({ projectDir: project("hooks-ambiguous"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(hooksJson(result).hooks.lensStatus).toBe("ambiguous")
    const husky = hooksJson(result).hooks.managers.find((m) => m.manager === "husky")
    expect(husky?.lensStatus).toBe("ambiguous")
    expect(
      result.machineOutput.diagnostics.some((d) => d.id === "hooks-ambiguous-husky")
    ).toBe(true)
  })

  it("reports installed even when a sibling manager lacks effect-lens", () => {
    const result = hooks({ projectDir: project("hooks-mixed"), cacheDir })
    expect(result.machineOutput.status).toBe(0)
    expect(hooksJson(result).hooks.lensStatus).toBe("installed")
    const husky = hooksJson(result).hooks.managers.find((m) => m.manager === "husky")
    expect(husky?.lensStatus).toBe("installed")
    const lintStaged = hooksJson(result).hooks.managers.find((m) => m.manager === "lint-staged")
    expect(lintStaged?.lensStatus).toBe("absent")
    // The sibling is an off note, not a warning, so it does not downgrade the exit code.
    expect(
      result.machineOutput.diagnostics.some(
        (d) => d.id === "hooks-lens-not-installed-lint-staged" && d.severity === "off"
      )
    ).toBe(true)
  })

  it("reports a non-object husky field as ambiguous", () => {
    const result = hooks({ projectDir: project("hooks-husky-null"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(hooksJson(result).hooks.lensStatus).toBe("ambiguous")
    const husky = hooksJson(result).hooks.managers.find((m) => m.manager === "husky")
    expect(husky?.lensStatus).toBe("ambiguous")
  })

  it("reports an unreadable package.json as ambiguous", () => {
    const result = hooks({ projectDir: project("hooks-bad-package-json"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    expect(hooksJson(result).hooks.lensStatus).toBe("ambiguous")
    const lintStaged = hooksJson(result).hooks.managers.find((m) => m.manager === "lint-staged")
    expect(lintStaged?.lensStatus).toBe("ambiguous")
  })

  it("emits a JSON payload with machineOutput and hooks", () => {
    const result = hooks({ projectDir: project("hooks-husky-installed"), cacheDir })
    const json = hooksJson(result)
    expect(json.machineOutput.status).toBe(0)
    expect(json.hooks.lensStatus).toBe("installed")
    expect(json.hooks.managers.map((m) => m.manager)).toEqual([
      "hk",
      "husky",
      "lefthook",
      "pre-commit",
      "lint-staged",
      "simple-git-hooks"
    ])
  })

  it("emits human-readable lines", () => {
    const result = hooks({ projectDir: project("hooks-husky-installed"), cacheDir })
    expect(result.human[0]).toBe("effect-lens hooks status")
    expect(result.human.join("\n")).toContain("lens checks: installed")
  })
})

describe("setup --dry-run", () => {
  it("reports a project needing setup as a warning with an ordered plan", () => {
    const result = setup({ projectDir: project("npm-valid"), cacheDir })
    expect(result.machineOutput.status).toBe(1)
    const plan = setupJson(result).plan
    expect(plan.steps.map((s) => s.id)).toEqual([
      "package-manager",
      "effect-dependency",
      "reference-pack",
      "oxlint-config",
      "hooks"
    ])
    expect(plan.steps.find((s) => s.id === "package-manager")?.status).toBe("ok")
    expect(plan.steps.find((s) => s.id === "oxlint-config")?.status).toBe("needed")
    expect(plan.steps.find((s) => s.id === "hooks")?.status).toBe("needed")
  })

  it("reports the hooks step as ok when lens checks are installed", () => {
    const result = setup({ projectDir: project("hooks-husky-installed"), cacheDir })
    const plan = setupJson(result).plan
    expect(plan.steps.find((s) => s.id === "hooks")?.status).toBe("ok")
  })

  it("reports an unsupported package manager as an error", () => {
    const result = setup({ projectDir: project("bun-lockfile"), cacheDir })
    expect(result.machineOutput.status).toBe(2)
    const plan = setupJson(result).plan
    expect(plan.steps.find((s) => s.id === "package-manager")?.status).toBe("unsupported")
    expect(
      result.machineOutput.diagnostics.some(
        (d) => d.id === "setup-step-unsupported-package-manager"
      )
    ).toBe(true)
  })

  it("reports an ambiguous hook manager as an unsupported hooks step", () => {
    const result = setup({ projectDir: project("hooks-ambiguous"), cacheDir })
    const plan = setupJson(result).plan
    expect(plan.steps.find((s) => s.id === "hooks")?.status).toBe("unsupported")
  })

  it("skips the reference-pack step when no effect dependency is declared", () => {
    const result = setup({ projectDir: project("missing-dependency"), cacheDir })
    const plan = setupJson(result).plan
    expect(plan.steps.find((s) => s.id === "reference-pack")?.status).toBe("skip")
  })

  it("emits a JSON payload with machineOutput and plan", () => {
    const result = setup({ projectDir: project("npm-valid"), cacheDir })
    const json = setupJson(result)
    expect(json.machineOutput.status).toBe(1)
    expect(json.plan.packageManager).toBe("npm")
    expect(json.plan.oxlint.status).toBe("missing")
    expect(json.plan.steps.length).toBeGreaterThan(0)
  })

  it("emits human-readable lines with the dry-run note", () => {
    const result = setup({ projectDir: project("npm-valid"), cacheDir })
    expect(result.human[0]).toBe("effect-lens setup --dry-run")
    expect(result.human.join("\n")).toContain("note: dry-run only; no files were changed")
  })
})

describe("read-only guarantee", () => {
  it("setup --dry-run changes no project files", () => {
    const dir = project("npm-valid")
    const before = snapshot(dir)
    setup({ projectDir: dir, cacheDir })
    const after = snapshot(dir)
    expect(after).toEqual(before)
  })

  it("hooks status changes no project files", () => {
    const dir = project("hooks-husky-installed")
    const before = snapshot(dir)
    hooks({ projectDir: dir, cacheDir })
    const after = snapshot(dir)
    expect(after).toEqual(before)
  })

  it("setup --dry-run changes no files even when a hook manager is present", () => {
    const dir = project("hooks-husky-installed")
    const before = snapshot(dir)
    setup({ projectDir: dir, cacheDir })
    const after = snapshot(dir)
    expect(after).toEqual(before)
  })
})
