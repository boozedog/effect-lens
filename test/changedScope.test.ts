/**
 * Tests for the reusable changed-file scope (`check --changed`, issue #14).
 *
 * These exercise the `resolveChangedFiles` resolver and the `check` adapter's
 * changed-file mode against real temporary git repositories (built at test
 * time so staged vs unstaged, deleted, and workspace filtering are genuine),
 * asserting that only matching staged files in the selected workspace are
 * linted, that configured oxlint ignores remain effective, that deleted and
 * unsupported paths are excluded, that an empty scope is a clean no-op, and
 * that human and JSON output identify the changed mode and selected scope.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveChangedFiles } from "../src/cli/changed.ts"
import { check } from "../src/cli/commands/check.ts"

const cacheDir = fileURLToPath(new URL("./fixtures/cache", import.meta.url))
const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const ENTRY = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url))

const runCli = (args: Array<string>): { stdout: string; status: number } => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    encoding: "utf8",
    cwd: repoRoot
  })
  return { stdout: result.stdout, status: result.status ?? -1 }
}

/**
 * Runs a git command in `dir` and returns the result.
 *
 * @since 0.0.0
 */
const git = (
  dir: string,
  ...args: Array<string>
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Writes `files` (repo-relative path → content) under `dir`.
 *
 * @since 0.0.0
 */
const writeFiles = (dir: string, files: Array<[string, string]>): void => {
  for (const [rel, content] of files) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

/**
 * Creates an initialised git repository with the given files present but not
 * staged, and stages all of them with `git add -A`.
 *
 * @since 0.0.0
 */
const repoWithStaged = (
  files: Array<[string, string]>,
  staged = true
): string => {
  const dir = mkdtempSync(join(tmpdir(), "effect-lens-changed-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "test")
  writeFiles(dir, files)
  if (staged) git(dir, "add", "-A")
  return dir
}

const ASYNC_A = "async function foo() {\n  return 1\n}\nvoid foo\n"
const ASYNC_B = "async function bar() {\n  return 2\n}\nvoid bar\n"
const ASYNC_C = "async function baz() {\n  return 3\n}\nvoid baz\n"

const workspaceConfig = (): [string, string] => [
  ".oxlintrc.json",
  JSON.stringify({
    rules: {},
    // oxlint resolves ignore patterns relative to the config dir (the
    // repository root), so a workspace-nested scripts dir needs the
    // `**/scripts/**` form to prove the project's ignore config is honoured
    // even inside the selected workspace.
    ignorePatterns: ["**/scripts/**"]
  })
]

describe("resolveChangedFiles (resolver)", () => {
  it("returns staged paths, excluding deleted files and filtering to the workspace", () => {
    const dir = repoWithStaged([
      ["packages/app/a.ts", ASYNC_A],
      ["packages/app/scripts/c.ts", ASYNC_C],
      ["packages/app/deleted.ts", ASYNC_B],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      // Stage the deletion of deleted.ts.
      rmSync(join(dir, "packages/app/deleted.ts"))
      git(dir, "add", "-u", "packages/app/deleted.ts")
      const scope = resolveChangedFiles({ projectDir: dir, workspace: "packages/app" })
      expect(scope.error).toBeNull()
      expect(scope.workspaceDir).toBe("packages/app")
      const files = scope.files.map((f) => f.replace(`${dir}/`, ""))
      expect(files).toContain("packages/app/a.ts")
      // Deleted files are excluded from the ACMR diff.
      expect(files).not.toContain("packages/app/deleted.ts")
      // Root files outside the workspace are excluded.
      expect(files).not.toContain("src/root.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns all staged paths when no workspace is selected", () => {
    const dir = repoWithStaged([
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const scope = resolveChangedFiles({ projectDir: dir })
      expect(scope.error).toBeNull()
      expect(scope.workspaceDir).toBeNull()
      const files = scope.files.map((f) => f.replace(`${dir}/`, ""))
      expect(files).toContain("packages/app/a.ts")
      expect(files).toContain("src/root.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a git error for a non-repository directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-changed-nogit-"))
    try {
      const scope = resolveChangedFiles({ projectDir: dir })
      expect(scope.error).not.toBeNull()
      expect(scope.files).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("check --changed (CLI adapter)", () => {
  it("lints only matching staged files in the selected workspace", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["packages/app/b.ts", ASYNC_B],
      ["packages/app/scripts/c.ts", ASYNC_C],
      ["packages/app/unsupported.json", "{\"a\":1}\n"],
      ["packages/app/deleted.ts", ASYNC_C],
      ["src/root.ts", ASYNC_B],
      ["packages/other/d.ts", ASYNC_B]
    ])
    try {
      // Stage the deletion of deleted.ts.
      rmSync(join(dir, "packages/app/deleted.ts"))
      git(dir, "add", "-u", "packages/app/deleted.ts")
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      const files = result.machineOutput.findings.map((f) => f.location.file)
      // Only the two workspace source files are linted.
      expect(files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(files.some((f) => f.includes("packages/app/b.ts"))).toBe(true)
      // Root and other-workspace files are excluded.
      expect(files.some((f) => f.includes("src/root.ts"))).toBe(false)
      expect(files.some((f) => f.includes("packages/other/d.ts"))).toBe(false)
      // Configured ignores stay effective inside the workspace.
      expect(files.some((f) => f.includes("scripts/c.ts"))).toBe(false)
      // Deleted and unsupported paths never produce findings.
      expect(files.some((f) => f.includes("deleted.ts"))).toBe(false)
      expect(files.some((f) => f.includes("unsupported.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("excludes unstaged-only files (staged versus unstaged behavior)", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A]
    ])
    try {
      // An untracked (unstaged-only) file with a finding must not be linted.
      writeFiles(dir, [["packages/app/unstaged.ts", ASYNC_B]])
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      const files = result.machineOutput.findings.map((f) => f.location.file)
      expect(files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(files.some((f) => f.includes("unstaged.ts"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a clean no-op with an explicit report when no staged files match", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["src/root.ts", ASYNC_A]
    ])
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      expect(result.machineOutput.status).toBe(0)
      expect(result.machineOutput.findings).toHaveLength(0)
      expect(result.human.join("\n")).toContain("scope: no staged files to lint")
      const json = result.json as {
        scope: { kind: string; files: Array<unknown>; error: string | null }
        oxlint: { changed: boolean }
      }
      expect(json.scope.kind).toBe("changed")
      expect(json.scope.files).toHaveLength(0)
      expect(json.scope.error).toBeNull()
      expect(json.oxlint.changed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves a basename workspace target to its importer path", () => {
    const dir = repoWithStaged([
      [
        "pnpm-lock.yaml",
        [
          "lockfileVersion: '9.0'",
          "",
          "importers:",
          "  packages/app:",
          "    dependencies:",
          "      effect:",
          "        specifier: 4.0.0-beta.83",
          "        version: 4.0.0-beta.83",
          "",
          "packages:",
          "  effect@4.0.0-beta.83:",
          "    resolution: {integrity: sha512-beta83integrity}",
          ""
        ].join("\n")
      ],
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      // `--workspace app` (basename) resolves to the packages/app importer.
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "app",
        changed: true,
        mode: "unified"
      })
      const files = result.machineOutput.findings.map((f) => f.location.file)
      expect(files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(files.some((f) => f.includes("src/root.ts"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("normalizes a ./-prefixed importer key when resolving a basename target", () => {
    // matchPnpmImporter also accepts a `./packages/app` importer key; the
    // workspace prefix must be normalized so git's `packages/app/...` staged
    // paths still match (a raw `./packages/app/` prefix would match nothing).
    const dir = repoWithStaged([
      [
        "pnpm-lock.yaml",
        [
          "lockfileVersion: '9.0'",
          "",
          "importers:",
          "  ./packages/app:",
          "    dependencies:",
          "      effect:",
          "        specifier: 4.0.0-beta.83",
          "        version: 4.0.0-beta.83",
          "",
          "packages:",
          "  effect@4.0.0-beta.83:",
          "    resolution: {integrity: sha512-beta83integrity}",
          ""
        ].join("\n")
      ],
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "app",
        changed: true,
        mode: "unified"
      })
      const files = result.machineOutput.findings.map((f) => f.location.file)
      expect(files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(files.some((f) => f.includes("src/root.ts"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lints all staged files across the repo when no workspace is selected", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const result = check({ projectDir: dir, cacheDir, changed: true, mode: "unified" })
      const files = result.machineOutput.findings.map((f) => f.location.file)
      expect(files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(files.some((f) => f.includes("src/root.ts"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits JSON identifying changed mode and the selected scope", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      const json = result.json as {
        scope: { kind: string; workspace: string | null; files: Array<string> }
        oxlint: { changed: boolean; mode: string }
      }
      expect(json.scope.kind).toBe("changed")
      expect(json.scope.workspace).toBe("packages/app")
      expect(json.scope.files.length).toBeGreaterThan(0)
      expect(json.scope.files.every((f) => f.includes("packages/app/"))).toBe(true)
      expect(json.oxlint.changed).toBe(true)
      expect(json.oxlint.mode).toBe("unified")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits human output identifying changed mode and the selected scope", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const result = check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      const human = result.human.join("\n")
      expect(human).toContain("effect-lens check (unified, changed)")
      expect(human).toContain("scope: 1 changed file(s) to lint")
      expect(human).toContain("workspace: packages/app")
      expect(human).toContain("changed files:")
      expect(human).toContain("packages/app/a.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("emits a warning diagnostic when the changed scope cannot be read (not a repo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-changed-norepo-"))
    try {
      writeFiles(dir, [workspaceConfig(), ["src/a.ts", ASYNC_A]])
      const result = check({ projectDir: dir, cacheDir, changed: true, mode: "unified" })
      expect(
        result.machineOutput.diagnostics.some(
          (d) => d.id === "check-changed-scope-unavailable"
        )
      ).toBe(true)
      expect(result.machineOutput.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("leaves no transient config behind in changed-file mode", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A]
    ])
    try {
      check({
        projectDir: dir,
        cacheDir,
        workspace: "packages/app",
        changed: true,
        mode: "unified"
      })
      const leftovers = readdirSync(dir).filter((f) => f.startsWith(".effect-lens-check-oxlintrc-"))
      expect(leftovers).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("wires --changed --workspace through the CLI process (JSON scope and exit code)", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      const { stdout, status } = runCli([
        "check",
        "--project",
        dir,
        "--cache",
        cacheDir,
        "--workspace",
        "packages/app",
        "--mode",
        "unified",
        "--changed",
        "--json"
      ])
      // The staged workspace finding makes the gate exit 2.
      expect(status).toBe(2)
      const json = JSON.parse(stdout) as {
        scope: { kind: string; workspace: string; files: Array<string> }
        oxlint: { changed: boolean }
      }
      expect(json.scope.kind).toBe("changed")
      expect(json.scope.workspace).toBe("packages/app")
      expect(json.scope.files.some((f) => f.includes("packages/app/a.ts"))).toBe(true)
      expect(json.scope.files.some((f) => f.includes("src/root.ts"))).toBe(false)
      expect(json.oxlint.changed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps explicit --path and default full-project checks compatible", () => {
    const dir = repoWithStaged([
      workspaceConfig(),
      ["packages/app/a.ts", ASYNC_A],
      ["src/root.ts", ASYNC_B]
    ])
    try {
      // Explicit --path still lints a single file.
      const pathResult = check({
        projectDir: dir,
        cacheDir,
        path: "packages/app/a.ts",
        mode: "unified"
      })
      expect(pathResult.machineOutput.status).toBe(2)
      // Default full-project check (no --path, no --changed) lints the tree.
      const fullResult = check({ projectDir: dir, cacheDir, mode: "unified" })
      expect(fullResult.machineOutput.status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
