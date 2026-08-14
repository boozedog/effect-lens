/**
 * Mutating hook install/uninstall operation for `hooks install`,
 * `hooks uninstall`, and `setup --apply`.
 *
 * The initial mutation slice targets the `hk` hook manager (jdx/hk) only. hk is
 * configured by a `hk.pkl` file (Pkl), so this operation adds a Lens-owned step
 * to the `pre-commit` hook's `steps` mapping and removes exactly that step on
 * uninstall, leaving all other lines and configuration untouched.
 *
 * Supported shapes:
 *
 * - `steps { ... }` — an inline steps mapping under `pre-commit`: the Lens step
 *   is inserted before the mapping's closing brace.
 * - `steps = <identifier>` — a variable reference (e.g. `steps = linters`): the
 *   line is rewritten to an inline mapping that spreads the variable and adds
 *   the Lens step, e.g. `steps { ...linters <lens step> }`.
 *
 * Unsupported shapes are refused with an actionable diagnostic rather than
 * guessed at: no `pre-commit` hook, no `steps` entry, a `steps` value that is
 * neither an inline mapping nor a simple variable reference, an unreadable or
 * unbalanced config, or a config that references `effect-lens` without a
 * Lens-owned marker block. Creating a `hk.pkl` from scratch is refused: hk's
 * base config is version-pinned, so the user runs `hk init` first. No mutation
 * is ever partial: a refusal writes nothing.
 *
 * @since 0.0.0
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HookMutationResult, HookOperation, makeHookMutationResult } from "../HookMutation.ts"
import { hooksStatus } from "./hooks.ts"
import { makeDiagnostic } from "./shared.ts"

/**
 * The hk config file names hk searches, in precedence order (first match
 * wins). `hk.local.pkl` is local-only; `hk.pkl` is the standard project config.
 *
 * @since 0.0.0
 */
const HK_CONFIG_NAMES = [
  "hk.local.pkl",
  ".config/hk.local.pkl",
  "hk.pkl",
  ".config/hk.pkl"
]

/**
 * The opening marker of the Lens-owned Pkl step block. Everything between this
 * and the closing marker is Lens-owned and safe to remove on uninstall.
 *
 * @since 0.0.0
 */
const START_MARKER = "// === effect-lens:start ==="

/**
 * The closing marker of the Lens-owned Pkl step block.
 *
 * @since 0.0.0
 */
const END_MARKER = "// === effect-lens:end ==="

/**
 * The name of the Lens-owned hk step and the check command it runs.
 *
 * @since 0.0.0
 */
const LENS_STEP = "effect-lens"
const LENS_COMMAND = "effect-lens check"

/**
 * Reads a file's text, or `null` when the path is absent or unreadable.
 *
 * @since 0.0.0
 */
const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * Returns the first existing hk config path (project-relative), or `null`.
 *
 * @since 0.0.0
 */
const findHkConfig = (projectDir: string): string | null =>
  HK_CONFIG_NAMES.find((name) => existsSync(join(projectDir, name))) ?? null

/**
 * Counts the `{`/`}` braces on a Pkl line, ignoring content inside double
 * quotes, Pkl raw strings (`#"..."#`), and line comments (`//`). Enough for the
 * hk.pkl shapes Lens targets.
 *
 * @since 0.0.0
 */
const braceDelta = (line: string): { open: number; close: number } => {
  let open = 0
  let close = 0
  let inString = false
  let inRawString = false
  let i = 0
  while (i < line.length) {
    const ch = line[i] as string
    const next = line[i + 1] as string | undefined
    if (inRawString) {
      if (ch === "\"" && next === "#") {
        inRawString = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (inString) {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === "\"") inString = false
      i += 1
      continue
    }
    if (ch === "#" && next === "\"") {
      inRawString = true
      i += 2
      continue
    }
    if (ch === "\"") {
      inString = true
      i += 1
      continue
    }
    if (ch === "/" && next === "/") break
    if (ch === "{") open += 1
    else if (ch === "}") close += 1
    i += 1
  }
  return { open, close }
}

/**
 * Returns the index of the line that closes the block opened on `openLine`, or
 * `-1` when the block is unbalanced.
 *
 * @since 0.0.0
 */
const matchingClose = (lines: Array<string>, openLine: number): number => {
  let depth = braceDelta(lines[openLine]).open - braceDelta(lines[openLine]).close
  if (depth <= 0) return -1
  for (let i = openLine + 1; i < lines.length; i += 1) {
    const d = braceDelta(lines[i])
    depth += d.open - d.close
    if (depth <= 0) return i
  }
  return -1
}

/**
 * The leading whitespace of a line.
 *
 * @since 0.0.0
 */
const indentOf = (line: string): string => {
  const m = /^(\s*)/.exec(line)
  return m?.[1] ?? ""
}

/**
 * A resolved target for inserting the Lens step into a `pre-commit` hook.
 *
 * - `inline` — insert before `closeLine` of an inline `steps { }` mapping.
 * - `assign` — rewrite the `steps = <identifier>` line at `line` to an inline
 *   mapping that spreads `assignee`.
 * - `missing` — no `pre-commit` steps target could be found.
 * - `unsupported` — a target was found but its shape cannot be merged safely.
 *
 * @since 0.0.0
 */
type StepsTarget =
  | { kind: "inline"; closeLine: number }
  | { kind: "assign"; line: number; assignee: string }
  | { kind: "missing" }
  | { kind: "unsupported"; detail: string }

/**
 * Locates the `pre-commit` hook's `steps` target in a hk.pkl config, or reports
 * why none can be used.
 *
 * @since 0.0.0
 */
const findStepsTarget = (lines: Array<string>): StepsTarget => {
  let preCommitLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\["pre-commit"\]\s*\{/.test(lines[i] as string)) {
      preCommitLine = i
      break
    }
  }
  if (preCommitLine === -1) return { kind: "missing" }
  const preCommitClose = matchingClose(lines, preCommitLine)
  if (preCommitClose === -1) {
    return { kind: "unsupported", detail: "pre-commit hook block is not balanced" }
  }
  for (let i = preCommitLine + 1; i < preCommitClose; i += 1) {
    const t = (lines[i] as string).trim()
    if (/^steps\s*\{/.test(t)) {
      const close = matchingClose(lines, i)
      if (close === -1) {
        return { kind: "unsupported", detail: "steps mapping is not balanced" }
      }
      return { kind: "inline", closeLine: close }
    }
    const m = /^steps\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(t)
    if (m) return { kind: "assign", line: i, assignee: m[1] as string }
    if (/^steps\s*=/.test(t)) {
      return {
        kind: "unsupported",
        detail: "steps value is not a simple inline mapping or variable reference"
      }
    }
  }
  return { kind: "missing" }
}

/**
 * Builds the Lens-owned Pkl step block, each line prefixed with `indent`.
 *
 * @since 0.0.0
 */
const lensBlock = (indent: string): Array<string> => [
  `${indent}${START_MARKER}`,
  `${indent}["${LENS_STEP}"] {`,
  `${indent}  check = "${LENS_COMMAND}"`,
  `${indent}}`,
  `${indent}${END_MARKER}`
]

/**
 * Describes the Lens-owned marker blocks present in a hk.pkl config.
 *
 * `present` is true when at least one start marker exists. `wellFormed` is true
 * only when the start and end marker line counts match AND the marker walk is
 * closed at end of file (no trailing or stray start marker). This deliberately
 * does not rely on bare substring `includes`, so a valid pair followed by a
 * stray start marker is detected as malformed rather than partially removed.
 *
 * @since 0.0.0
 */
const lensBlockState = (content: string): { present: boolean; wellFormed: boolean } => {
  let startCount = 0
  let endCount = 0
  let inBlock = false
  for (const line of content.split("\n")) {
    if (line.trim() === START_MARKER) {
      startCount += 1
      inBlock = true
    } else if (line.trim() === END_MARKER) {
      endCount += 1
      inBlock = false
    }
  }
  return {
    present: startCount > 0,
    wellFormed: startCount === endCount && !inBlock
  }
}

/**
 * Builds a refused {@link HookMutationResult} for a malformed Lens block.
 *
 * @since 0.0.0
 */
const refusedMalformed = (operation: HookOperation): HookMutationResult =>
  refused(
    operation,
    "hk.pkl contains a malformed effect-lens block (unclosed or stray markers); " +
      "remove it manually",
    `hooks-${operation}-hk-malformed`
  )

/**
 * Installs the Lens-owned step into the `pre-commit` steps of a hk.pkl config.
 * Returns a result; refuses (without writing) when the shape is unsupported,
 * the config is unreadable, or `effect-lens` is referenced without a Lens-owned
 * marker block.
 *
 * @since 0.0.0
 */
const installHk = (projectDir: string, relName: string): HookMutationResult => {
  const file = join(projectDir, relName)
  const content = readText(file)
  if (content === null) {
    return refused(
      "install",
      `cannot install hooks: ${relName} is present but unreadable`,
      "hooks-install-hk-unreadable"
    )
  }
  if (lensBlockState(content).present) {
    if (!lensBlockState(content).wellFormed) {
      return refusedMalformed("install")
    }
    return makeHookMutationResult({
      operation: "install",
      manager: "hk",
      targetPath: relName,
      outcome: "noop",
      changed: false,
      detail: "effect-lens step already installed in hk.pkl"
    })
  }
  if (content.includes("effect-lens")) {
    return refused(
      "install",
      "effect-lens is already referenced in hk.pkl but not as a Lens-owned step; " +
        "remove or convert the reference before installing",
      "hooks-install-hk-not-owned"
    )
  }
  const lines = content.split("\n")
  const target = findStepsTarget(lines)
  if (target.kind === "missing") {
    return refused(
      "install",
      "no pre-commit steps mapping found in hk.pkl; add a pre-commit hook with " +
        "an inline `steps { }` mapping or an inline `steps = <identifier>` reference",
      "hooks-install-hk-no-steps"
    )
  }
  if (target.kind === "unsupported") {
    return refused(
      "install",
      `cannot install hooks: ${target.detail}`,
      "hooks-install-hk-unsupported-shape"
    )
  }
  if (target.kind === "inline") {
    const indent = `${indentOf(lines[target.closeLine] as string)}  `
    lines.splice(target.closeLine, 0, ...lensBlock(indent))
  } else {
    const base = indentOf(lines[target.line] as string)
    const stepIndent = `${base}  `
    lines.splice(
      target.line,
      1,
      `${base}steps {`,
      `${stepIndent}...${target.assignee}`,
      ...lensBlock(stepIndent),
      `${base}}`
    )
  }
  writeFileSync(file, lines.join("\n"))
  return makeHookMutationResult({
    operation: "install",
    manager: "hk",
    targetPath: relName,
    outcome: "applied",
    changed: true,
    created: false,
    detail: `added effect-lens check step to ${relName}`
  })
}

/**
 * Removes the Lens-owned step block from a hk.pkl config, preserving every
 * other line. A no-op when no Lens-owned block is present. Refuses a malformed
 * block (a start marker without a matching end marker).
 *
 * @since 0.0.0
 */
const uninstallHk = (projectDir: string, relName: string): HookMutationResult => {
  const file = join(projectDir, relName)
  const content = readText(file)
  if (content === null) {
    return makeHookMutationResult({
      operation: "uninstall",
      manager: "hk",
      targetPath: relName,
      outcome: "noop",
      changed: false,
      detail: "no effect-lens step block in hk.pkl"
    })
  }
  const state = lensBlockState(content)
  if (!state.present) {
    return makeHookMutationResult({
      operation: "uninstall",
      manager: "hk",
      targetPath: relName,
      outcome: "noop",
      changed: false,
      detail: "no effect-lens step block in hk.pkl"
    })
  }
  if (!state.wellFormed) {
    return refusedMalformed("uninstall")
  }
  const kept: Array<string> = []
  let inBlock = false
  for (const line of content.split("\n")) {
    if (line.trim() === START_MARKER) {
      inBlock = true
      continue
    }
    if (line.trim() === END_MARKER) {
      inBlock = false
      continue
    }
    if (!inBlock) kept.push(line)
  }
  writeFileSync(file, kept.join("\n"))
  return makeHookMutationResult({
    operation: "uninstall",
    manager: "hk",
    targetPath: relName,
    outcome: "applied",
    changed: true,
    created: false,
    detail: `removed effect-lens step from ${relName}`
  })
}

/**
 * Builds a refused {@link HookMutationResult} with an error diagnostic.
 *
 * @since 0.0.0
 */
const refused = (
  operation: HookOperation,
  detail: string,
  id: string
): HookMutationResult =>
  makeHookMutationResult({
    operation,
    outcome: "refused",
    changed: false,
    detail,
    diagnostics: [
      makeDiagnostic({
        id,
        severity: "error",
        message: detail
      })
    ]
  })

/**
 * Runs an install or uninstall against the `hk` hook manager.
 *
 * The `hk` manager is the only mutation target in this slice. Any other manager
 * is ignored for mutation (the read-only status still reports them). Every
 * refusal happens before any file is written, so a mutation is never partial.
 *
 * @since 0.0.0
 */
export const applyHookMutation = (args: {
  projectDir: string
  operation: HookOperation
}): HookMutationResult => {
  const { projectDir, operation } = args
  const status = hooksStatus(projectDir)
  const hk = status.managers.find((m) => m.manager === "hk") ?? null
  const relName = findHkConfig(projectDir)

  if (hk !== null && hk.lensStatus === "ambiguous") {
    return refused(
      operation,
      `cannot ${operation} hooks: hk config is present but unreadable`,
      `hooks-${operation}-hk-ambiguous`
    )
  }

  if (operation === "install") {
    if (hk === null || !hk.present || relName === null) {
      return refused(
        operation,
        "cannot install hooks: no hk.pkl found; run `hk init` to generate one first",
        "hooks-install-hk-no-config"
      )
    }
    if (hk.lensStatus === "installed") {
      const content = readText(join(projectDir, relName))
      if (content !== null) {
        const state = lensBlockState(content)
        if (state.present) {
          if (!state.wellFormed) {
            return refusedMalformed(operation)
          }
          return makeHookMutationResult({
            operation,
            manager: "hk",
            targetPath: relName,
            outcome: "noop",
            changed: false,
            detail: "effect-lens step already installed in hk.pkl"
          })
        }
      }
      return refused(
        operation,
        "effect-lens is already referenced in hk.pkl but not as a Lens-owned step; " +
          "remove or convert the reference before installing",
        "hooks-install-hk-not-owned"
      )
    }
    return installHk(projectDir, relName)
  }

  // uninstall
  if (hk === null || !hk.present || relName === null) {
    return makeHookMutationResult({
      operation,
      outcome: "noop",
      changed: false,
      detail: "no hk.pkl config; nothing is installed"
    })
  }
  if (hk.lensStatus !== "installed") {
    return makeHookMutationResult({
      operation,
      outcome: "noop",
      changed: false,
      detail: "no effect-lens step is installed"
    })
  }
  const content = readText(join(projectDir, relName))
  if (content === null || !content.includes(START_MARKER)) {
    return refused(
      operation,
      "effect-lens is referenced in hk.pkl but not as a Lens-owned step; remove it manually",
      "hooks-uninstall-hk-not-owned"
    )
  }
  return uninstallHk(projectDir, relName)
}

export { HookMutationResult, HookOperation, makeHookMutationResult }
export type { Diagnostic } from "../Finding.ts"
