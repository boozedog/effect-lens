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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyHookMutation } from "../src/operations/hookMutation.ts"

const START_MARKER = "// === effect-lens:start ==="
const END_MARKER = "// === effect-lens:end ==="

const AMENDS =
  `amends "package://github.com/jdx/hk/releases/download/v1.55.0/hk@1.55.0#/Config.pkl"`

/**
 * A fake `effect-lens` executable used to satisfy the command-availability
 * precondition without depending on the real binary or a built `dist/`. The
 * path is passed as the `command` seam to `applyHookMutation`; the generated
 * hk step embeds it, so tests assert on the check flags rather than the exact
 * command name.
 *
 * @since 0.0.0
 */
let fakeCommandPath: string | null = null
const fakeCommand = (): string => {
  if (fakeCommandPath === null) {
    const dir = mkdtempSync(join(tmpdir(), "effect-lens-cmd-"))
    const bin = join(dir, "effect-lens")
    writeFakeBin(bin)
    fakeCommandPath = bin
  }
  return fakeCommandPath
}

/**
 * Writes an executable fake `effect-lens` shell script (exits 0) at `path`,
 * creating parent directories as needed. Used to satisfy the command-availability
 * and resolution preconditions without depending on the real binary.
 *
 * @since 0.0.0
 */
const writeFakeBin = (path: string): void => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
  writeFileSync(path, "#!/bin/sh\nexit 0\n")
  chmodSync(path, 0o755)
}

/**
 * Sets `process.env.PATH` to `value` for the duration of `fn`, restoring the
 * original value afterwards. Used to make PATH fallback and PATH-absence
 * resolution deterministic in tests.
 *
 * @since 0.0.0
 */
const withPath = (value: string, fn: () => void): void => {
  const original = process.env.PATH
  process.env.PATH = value
  try {
    fn()
  } finally {
    process.env.PATH = original
  }
}

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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
      expect(result.outcome).toBe("applied")
      expect(result.changed).toBe(true)
      expect(Option.getOrNull(result.manager)).toBe("hk")
      const content = read(dir)
      expect(content).toContain(START_MARKER)
      expect(content).toContain("[\"effect-lens\"]")
      expect(content).toContain("check --mode unified --changed")
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).not.toContain("steps = linters")
      expect(content).toContain("...linters")
      expect(content).toContain("[\"effect-lens\"]")
      expect(content).toContain(START_MARKER)
      expect(content).toContain("check --mode unified --changed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is a no-op on repeat install with no duplicate step", () => {
    const dir = inlineProject()
    try {
      expect(
        applyHookMutation({ projectDir: dir, operation: "install", command: fakeCommand() }).outcome
      ).toBe(
        "applied"
      )
      const second = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
      expect(result.outcome).toBe("refused")
      expect(
        result.diagnostics.some((d) => d.id === "hooks-install-hk-unsupported-shape")
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generates a scoped unified changed-file command with no workspace", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      // The step runs the unified changed-file gate, not an unscoped check.
      expect(content).toContain("check --mode unified --changed")
      expect(content).not.toContain("check = \"effect-lens check\"")
      // No workspace is selected, so no --workspace flag is emitted.
      expect(content).not.toContain("--workspace")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes an explicitly selected workspace into the generated command", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "packages/foldkit"
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).toContain("check --mode unified --changed")
      expect(content).toContain("--workspace 'packages/foldkit'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("shell-quotes a workspace target with spaces", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "packages/my app"
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).toContain("--workspace 'packages/my app'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("escapes a workspace target for the Pkl string", () => {
    const dir = inlineProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "packages/\"quoted\""
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      // The workspace is shell-quoted, then Pkl-escaped for the check string.
      expect(content).toContain("--workspace 'packages/\\\"quoted\\\"'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses when the effect-lens command is unavailable (no partial write)", () => {
    const dir = inlineProject()
    try {
      const before = read(dir)
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: "/nonexistent/effect-lens"
      })
      expect(result.outcome).toBe("refused")
      expect(result.changed).toBe(false)
      expect(
        result.diagnostics.some((d) => d.id === "hooks-install-hk-command-unavailable")
      ).toBe(true)
      // No partial write: the config is unchanged.
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hooks uninstall (hk)", () => {
  it("removes the Lens step and preserves non-Lens steps", () => {
    const dir = inlineProject()
    try {
      applyHookMutation({ projectDir: dir, operation: "install", command: fakeCommand() })
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
      applyHookMutation({ projectDir: dir, operation: "install", command: fakeCommand() })
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
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand()
      })
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
      applyHookMutation({ projectDir: dir, operation: "install", command: fakeCommand() })
      applyHookMutation({ projectDir: dir, operation: "uninstall" })
      const third = applyHookMutation({ projectDir: dir, operation: "uninstall" })
      expect(third.outcome).toBe("noop")
      expect(third.changed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A pnpm lockfile declaring `packages/foldkit` (unique basename `foldkit`)
 * and two `.../kit` importers (`kit` is an ambiguous basename target).
 *
 * @since 0.0.0
 */
const workspaceLock = (): string =>
  `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.3

  packages/foldkit:
    dependencies:
      effect:
        specifier: 4.0.0-beta.83
        version: 4.0.0-beta.83

  packages/tools/kit:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

  apps/kit:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

packages:

  effect@4.0.0-beta.83:
    resolution: {integrity: sha512-beta83}
    dependencies:
      fast-check: 4.9.0

  effect@4.0.0-rc.109:
    resolution: {integrity: sha512-rc109}
    dependencies:
      fast-check: 4.9.0
`

describe("hooks install workspace validation", () => {
  const pnpmProject = (): string => {
    const dir = inlineProject()
    writeFileSync(join(dir, "pnpm-lock.yaml"), workspaceLock())
    return dir
  }

  it("refuses an unresolved workspace target before writing (no partial write)", () => {
    const dir = pnpmProject()
    try {
      const before = read(dir)
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "does-not-exist"
      })
      expect(result.outcome).toBe("refused")
      expect(result.changed).toBe(false)
      expect(
        result.diagnostics.some((d) => d.id === "hooks-install-hk-workspace-unresolved")
      ).toBe(true)
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses an ambiguous workspace target before writing (no partial write)", () => {
    const dir = pnpmProject()
    try {
      const before = read(dir)
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "kit"
      })
      expect(result.outcome).toBe("refused")
      expect(result.changed).toBe(false)
      expect(
        result.diagnostics.some((d) => d.id === "hooks-install-hk-workspace-ambiguous")
      ).toBe(true)
      expect(read(dir)).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("canonicalizes a valid basename workspace target in the generated command", () => {
    const dir = pnpmProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "foldkit"
      })
      expect(result.outcome).toBe("applied")
      // The basename target is canonicalized to the full importer path so the
      // generated hook lints exactly the selected workspace.
      expect(read(dir)).toContain("--workspace 'packages/foldkit'")
      expect(read(dir)).not.toContain("--workspace 'foldkit'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves a full importer path workspace in the generated command", () => {
    const dir = pnpmProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: fakeCommand(),
        workspace: "packages/foldkit"
      })
      expect(result.outcome).toBe("applied")
      expect(read(dir)).toContain("--workspace 'packages/foldkit'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hooks install command resolution", () => {
  /**
   * A temp project with a real `hk.pkl` and a project-local
   * `node_modules/.bin/effect-lens` executable, simulating a consumer that
   * installs effect-lens as a local devDependency (no global install).
   *
   * @since 0.0.0
   */
  const localBinProject = (): string => {
    const dir = inlineProject()
    writeFakeBin(join(dir, "node_modules", ".bin", "effect-lens"))
    return dir
  }

  it("prefers a project-local node_modules/.bin/effect-lens without an override or PATH", () => {
    const dir = localBinProject()
    try {
      const result = applyHookMutation({ projectDir: dir, operation: "install" })
      expect(result.outcome).toBe("applied")
      expect(result.changed).toBe(true)
      const localBin = join(dir, "node_modules", ".bin", "effect-lens")
      const content = read(dir)
      // The absolute local binary path is embedded, not a bare PATH command.
      expect(content).toContain(`check = "'${localBin}' check --mode unified --changed"`)
      expect(content).not.toContain("check = \"'effect-lens'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("includes workspace scope when requested with a local binary", () => {
    const dir = localBinProject()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        workspace: "packages/foldkit"
      })
      expect(result.outcome).toBe("applied")
      const localBin = join(dir, "node_modules", ".bin", "effect-lens")
      expect(read(dir)).toContain(
        `check = "'${localBin}' check --mode unified --changed --workspace 'packages/foldkit'"`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("shell-quotes a project-local binary path containing a space", () => {
    const dir = localBinProject()
    const spacedDir = join(dir, "my project")
    mkdirSync(spacedDir, { recursive: true })
    writeFileSync(join(spacedDir, "hk.pkl"), read(dir))
    writeFakeBin(join(spacedDir, "node_modules", ".bin", "effect-lens"))
    try {
      const result = applyHookMutation({ projectDir: spacedDir, operation: "install" })
      expect(result.outcome).toBe("applied")
      const localBin = join(spacedDir, "node_modules", ".bin", "effect-lens")
      // The spaced absolute path is embedded as a single shell-quoted token.
      expect(read(spacedDir)).toContain(`check = "'${localBin}' check --mode unified --changed"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses an explicit override even when a local binary exists", () => {
    const dir = localBinProject()
    const override = fakeCommand()
    try {
      const result = applyHookMutation({
        projectDir: dir,
        operation: "install",
        command: override
      })
      expect(result.outcome).toBe("applied")
      const content = read(dir)
      expect(content).toContain(`check = "'${override}' check`)
      // The override wins; the local binary path is not embedded.
      expect(content).not.toContain(join(dir, "node_modules"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to the effect-lens command on PATH when no local binary exists", () => {
    const dir = inlineProject()
    const pathDir = mkdtempSync(join(tmpdir(), "effect-lens-path-"))
    writeFakeBin(join(pathDir, "effect-lens"))
    try {
      withPath(pathDir, () => {
        const result = applyHookMutation({ projectDir: dir, operation: "install" })
        expect(result.outcome).toBe("applied")
        expect(read(dir)).toContain(`check = "'effect-lens' check --mode unified --changed"`)
      })
    } finally {
      rmSync(pathDir, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses with an actionable local-install diagnostic when no command resolves", () => {
    const dir = inlineProject()
    const emptyPath = mkdtempSync(join(tmpdir(), "effect-lens-nopath-"))
    try {
      const before = read(dir)
      withPath(emptyPath, () => {
        const result = applyHookMutation({ projectDir: dir, operation: "install" })
        expect(result.outcome).toBe("refused")
        expect(result.changed).toBe(false)
        const d = result.diagnostics.find(
          (x) => x.id === "hooks-install-hk-command-unavailable"
        )
        expect(d).toBeDefined()
        // The diagnostic is actionable and does not recommend a global install.
        expect(d?.message).toContain("devDependency")
        expect(d?.message).not.toContain("npm install -g")
        // No partial write: the config is unchanged.
        expect(read(dir)).toBe(before)
      })
    } finally {
      rmSync(emptyPath, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
