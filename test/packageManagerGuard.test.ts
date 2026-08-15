/**
 * Tests for the package-manager guard (issue #11).
 *
 * The guard deterministically rejects accidental active references to pnpm as
 * a required tool across the repository's active project/CI workflow surface
 * (`package.json`, GitHub Actions workflows, `README.md`, `docs/*.md`, and
 * `scripts/*`), while allowing the pnpm lockfile *format* (which Nub reads
 * directly) and descriptive product text. These tests exercise the guard
 * function against the repository and against temporary projects that model
 * the rejection and allowance paths.
 *
 * @since 0.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runPackageManagerGuard } from "../scripts/package-manager-guard.mjs"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const GUARD = fileURLToPath(new URL("../scripts/package-manager-guard.mjs", import.meta.url))
const runProcess = (args: Array<string>) =>
  spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", cwd: repoRoot })

const tempProject = (): string => mkdtempSync(join(tmpdir(), "effect-lens-guard-"))

const write = (dir: string, rel: string, content: string): void => {
  const path = join(dir, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content, "utf8")
}

describe("package-manager guard", () => {
  it("passes against this repository's active project/CI surface", () => {
    const result = runPackageManagerGuard({ repoRoot })
    expect(result.ok).toBe(true)
    expect(result.checked).toContain("package.json")
    expect(result.checked).toContain(".github/workflows/ci.yml")
    expect(result.checked).toContain("README.md")
    expect(result.problems).toEqual([])
  })

  it("rejects a pnpm packageManager declaration", () => {
    const dir = tempProject()
    write(dir, "package.json", JSON.stringify({ packageManager: "pnpm@11.20.0" }, null, 2))
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.includes("packageManager declaration"))).toBe(true)
  })

  it("rejects pnpm command invocations in package scripts", () => {
    const dir = tempProject()
    write(
      dir,
      "package.json",
      JSON.stringify({ scripts: { verify: "pnpm lint && pnpm check" } }, null, 2)
    )
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.includes("package.json"))).toBe(true)
  })

  it("rejects pnpm usage in CI workflows (action, cache, and run)", () => {
    const dir = tempProject()
    write(
      dir,
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  verify:",
        "    steps:",
        "      - uses: pnpm/action-setup@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          cache: pnpm",
        "      - name: Install",
        "        run: pnpm install --frozen-lockfile"
      ].join("\n")
    )
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(false)
    expect(result.problems.length).toBeGreaterThanOrEqual(3)
  })

  it("rejects pnpm references in docs and scripts", () => {
    const dir = tempProject()
    write(dir, "package.json", JSON.stringify({ scripts: { lint: "oxlint" } }, null, 2))
    write(dir, "README.md", "Run `pnpm verify` after editing.\n")
    write(dir, "docs/ci.md", "Install with `pnpm install --frozen-lockfile`.\n")
    write(dir, "scripts/check.mjs", "const run = \"pnpm lint\"\n")
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(false)
    expect(result.problems.length).toBeGreaterThanOrEqual(3)
  })

  it("allows the pnpm lockfile format and descriptive product text", () => {
    const dir = tempProject()
    write(dir, "package.json", JSON.stringify({ scripts: { lint: "oxlint" } }, null, 2))
    write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    write(
      dir,
      "README.md",
      "Nub reads the committed pnpm-lock.yaml directly. npm and pnpm are supported lockfile formats.\n"
    )
    write(
      dir,
      "docs/contracts.md",
      "The plan reports a packageManager of \"pnpm@11.20.0 | null\".\n"
    )
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  it("does not scan product source or test files (narrowness)", () => {
    const dir = tempProject()
    write(dir, "package.json", JSON.stringify({ scripts: { lint: "oxlint" } }, null, 2))
    // Product code legitimately parses pnpm lockfiles; these MUST be ignored.
    write(dir, "src/Resolver.ts", "export const cmd = \"pnpm install --frozen-lockfile\"\n")
    write(dir, "test/Resolver.test.ts", "export const cmd = \"pnpm verify\"\n")
    const result = runPackageManagerGuard({ repoRoot: dir })
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
    expect(result.checked).not.toContain("src/Resolver.ts")
    expect(result.checked).not.toContain("test/Resolver.test.ts")
  })
})

describe("package-manager guard process", () => {
  it("exits 0 and prints the passed summary against the repository", () => {
    const result = runProcess([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("package-manager guard passed")
  })

  it("exits 1 and names the offending file for a pnpm reference", () => {
    const dir = tempProject()
    write(dir, "package.json", JSON.stringify({ packageManager: "pnpm@11.20.0" }, null, 2))
    const result = runProcess(["--repo", dir])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("package-manager guard FAILED")
  })
})
