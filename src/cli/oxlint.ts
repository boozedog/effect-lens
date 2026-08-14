/**
 * Read-only oxlint runner for the `check` command.
 *
 * Runs the oxlint binary with the Lens plugin loaded, parses the JSON
 * diagnostics, and returns them as {@link Review.OxlintDiagnostic} values for
 * the shared-core `review` operation. It never mutates the project: the
 * generated oxlint config is written to a scratch file in the OS temp dir and
 * removed afterwards. If oxlint is unavailable or fails, an error string is
 * returned instead of crashing.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Review from "../operations/review.ts"
import { rules } from "../rules/index.ts"

const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * The result of an oxlint run: the parsed diagnostics, the number of files
 * linted, and an error string when oxlint could not run.
 *
 * @since 0.0.0
 */
export interface OxlintRun {
  readonly diagnostics: Array<Review.OxlintDiagnostic>
  readonly files: number
  readonly error: string | null
}

/**
 * Resolves the oxlint binary: the effect-lens package's own copy first, then
 * the project's copy, then PATH. Returns `null` when none is found.
 *
 * @since 0.0.0
 */
const resolveOxlintBin = (projectDir: string): string | null => {
  const local = join(moduleDir, "..", "..", "node_modules", ".bin", "oxlint")
  if (existsSync(local)) return local
  const project = join(projectDir, "node_modules", ".bin", "oxlint")
  if (existsSync(project)) return project
  const probe = spawnSync("oxlint", ["--version"], { encoding: "utf8" })
  return probe.error === undefined ? "oxlint" : null
}

/**
 * Builds the oxlint config that loads the Lens plugin and enables the Lens
 * rules at their catalog severities, plus the standard correctness/suspicious
 * categories. The plugin path is resolved relative to this module so the CLI
 * works from a checked-out project.
 *
 * @since 0.0.0
 */
const buildConfig = (): Record<string, unknown> => {
  const pluginPath = resolve(moduleDir, "..", "plugin", "index.ts")
  const lensRules: Record<string, string> = {}
  for (const rule of rules) {
    lensRules[rule.id] = rule.severity
  }
  return {
    jsPlugins: [pluginPath],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "warn"
    },
    rules: lensRules,
    ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/coverage/**"]
  }
}

/**
 * Decodes a raw oxlint JSON diagnostic into a {@link Review.OxlintDiagnostic},
 * or `null` when the shape is not decodable.
 *
 * @since 0.0.0
 */
const decodeDiagnostic = (raw: unknown): Review.OxlintDiagnostic | null => {
  const d = raw as {
    message?: unknown
    code?: unknown
    severity?: unknown
    filename?: unknown
    labels?: Array<{ span?: { line?: unknown; column?: unknown } }>
  }
  if (
    typeof d.message !== "string" ||
    typeof d.code !== "string" ||
    typeof d.filename !== "string"
  ) {
    return null
  }
  const severity = d.severity === "warning" ? "warning" : "error"
  const labels = (d.labels ?? []).map((label) => {
    const span = label.span
    const line = typeof span?.line === "number" ? span.line : 1
    const column = typeof span?.column === "number" ? span.column : 1
    return new Review.OxlintLabel({
      span: Option.some(new Review.OxlintSpan({ line, column }))
    })
  })
  return new Review.OxlintDiagnostic({
    message: d.message,
    code: d.code,
    severity,
    filename: d.filename,
    labels
  })
}

/**
 * Runs oxlint read-only over `target` (a file or directory) with the Lens
 * plugin loaded. Returns the parsed diagnostics plus a count of linted files,
 * or an error string when oxlint is unavailable or its output is unparseable.
 *
 * @since 0.0.0
 */
export const runOxlint = (args: { projectDir: string; target: string }): OxlintRun => {
  const oxlintBin = resolveOxlintBin(args.projectDir)
  if (oxlintBin === null) {
    return {
      diagnostics: [],
      files: 0,
      error: "oxlint binary not found; install oxlint to run check"
    }
  }
  const config = buildConfig()
  const scratchDir = mkdtempSync(join(tmpdir(), "effect-lens-check-"))
  const configPath = join(scratchDir, "oxlintrc.json")
  writeFileSync(configPath, JSON.stringify(config))
  try {
    const result = spawnSync(oxlintBin, ["-c", configPath, "--format", "json", args.target], {
      encoding: "utf8"
    })
    if (result.error !== undefined) {
      return {
        diagnostics: [],
        files: 0,
        error: `oxlint failed to start: ${result.error.message}`
      }
    }
    const stderrNote = result.stderr.trim() === "" ? "" : ` (${result.stderr.trim()})`
    // oxlint may prefix a human line (e.g. "No files found to lint...") before
    // the JSON object; extract the first `{` so parsing is robust.
    const jsonStart = result.stdout.indexOf("{")
    if (jsonStart === -1) {
      return {
        diagnostics: [],
        files: 0,
        error: `oxlint produced no JSON output${stderrNote}`
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout.slice(jsonStart))
    } catch {
      return {
        diagnostics: [],
        files: 0,
        error: `oxlint produced unparseable output${stderrNote}`
      }
    }
    const data = parsed as { diagnostics?: Array<unknown>; number_of_files?: unknown }
    const diagnostics = (data.diagnostics ?? [])
      .map((d) => decodeDiagnostic(d))
      .filter((d): d is Review.OxlintDiagnostic => d !== null)
    const files = typeof data.number_of_files === "number" ? data.number_of_files : 0
    return { diagnostics, files, error: null }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}
