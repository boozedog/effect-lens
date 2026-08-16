/**
 * Read-only oxlint runner for the `check` command.
 *
 * Runs the oxlint binary with the Lens plugin loaded, parses the JSON
 * diagnostics, and returns them as {@link Review.OxlintDiagnostic} values for
 * the shared-core `review` operation. In `lens-only` mode (the default) a
 * fresh scratch config is written to the OS temp dir. In `unified` mode the
 * target repository's oxlint config is loaded and composed with the Lens
 * plugin/rules, written to a transient file in the project directory, and
 * removed afterwards — so ignores, overrides, and rule settings are preserved
 * while the Lens rules are loaded. The check never leaves artifacts behind and
 * never modifies the project's own config. If oxlint is unavailable or fails,
 * an error string is returned instead of crashing.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadOxlintConfig } from "../operations/oxlintConfig.ts"
import * as Review from "../operations/review.ts"
import { type CheckMode, DEFAULT_CHECK_MODE } from "../provider/Provider.ts"
import { rules } from "../rules/index.ts"

const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * Resolves the Lens plugin entrypoint relative to this module. From a
 * checked-out source tree the plugin is `src/plugin/index.ts`; from the
 * published package it is the compiled `dist/plugin/index.js`. The `.ts` path
 * is preferred when present so the source tree and the published artifact both
 * resolve correctly.
 *
 * @since 0.1.0
 */
const resolvePluginPath = (): string => {
  const tsPath = resolve(moduleDir, "..", "plugin", "index.ts")
  if (existsSync(tsPath)) return tsPath
  return resolve(moduleDir, "..", "plugin", "index.js")
}

/**
 * Walks up from `start` looking for the nearest `node_modules/.bin/oxlint`.
 * This resolves the oxlint binary whether it is a dependency of the
 * effect-lens package (published, in an isolated virtual store) or a
 * devDependency at the repository root (source checkout). Returns `null` when
 * no copy is found within the walk.
 *
 * @since 0.1.0
 */
const findUpOxlintBin = (start: string): string | null => {
  let dir = start
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "node_modules", ".bin", "oxlint")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Builds the `--ignore-pattern` flags that keep oxlint from walking the
 * dependency tree when it lints a whole project directory. The Nub isolated
 * virtual store lives under `node_modules/.store`, and its packages are
 * symlinked into the per-user pm store under `~/.cache/nub`; oxlint follows
 * those symlinks and reports the real paths, so both the `node_modules` tree
 * and the pm store must be ignored. Returns an array of `--ignore-pattern`
 * flag pairs ready to splice into the oxlint argv.
 *
 * @since 0.1.0
 */
const buildIgnorePatterns = (): Array<string> => {
  const patterns = ["**/node_modules/**", "**/.store/**"]
  const pmStore = join(homedir(), ".cache", "nub")
  if (existsSync(pmStore)) patterns.push(`${pmStore}/**`)
  return patterns.flatMap((p) => ["--ignore-pattern", p])
}

/**
 * The prefix of the transient oxlint config written into the project directory
 * in `unified` mode. A unique suffix (pid + timestamp) avoids collisions
 * between concurrent runs. The file is always removed after the run.
 *
 * @since 0.0.0
 */
const TRANSIENT_CONFIG_PREFIX = ".effect-lens-check-oxlintrc-"

const transientConfigName = (): string =>
  `${TRANSIENT_CONFIG_PREFIX}${process.pid}-${Date.now()}.json`

/**
 * Which oxlint config a run used: the built-in Lens scratch config, the
 * project's composed config, or none (oxlint unavailable).
 *
 * @since 0.0.0
 */
export type ConfigSource = "builtin" | "project" | "none"

/**
 * The result of an oxlint run: the parsed diagnostics, the number of files
 * linted, the gate mode, the config source, and an error string when oxlint
 * could not run.
 *
 * @since 0.0.0
 */
export interface OxlintRun {
  readonly diagnostics: Array<Review.OxlintDiagnostic>
  readonly files: number
  readonly error: string | null
  readonly mode: CheckMode
  readonly configSource: ConfigSource
  readonly configWarning: string | null
}

/**
 * Resolves the oxlint binary: the effect-lens package's own copy first, then
 * the project's copy, then PATH. Returns `null` when none is found.
 *
 * @since 0.0.0
 */
const resolveOxlintBin = (projectDir: string): string | null => {
  const local = findUpOxlintBin(moduleDir)
  if (local !== null) return local
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
  const pluginPath = resolvePluginPath()
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
 * Loads the target repository's oxlint config from the project directory via
 * the shared {@link loadOxlintConfig} loader (which normalizes unreadable,
 * unparseable, or non-object config values — including valid JSON `null` — to
 * `ambiguous`). Returns the parsed config and the directory it lives in (for
 * resolving relative plugin paths), `{ unparseable: true }` when the config is
 * ambiguous, or `null` when no config is present.
 *
 * @since 0.0.0
 */
const loadProjectConfig = (
  projectDir: string
): { config: Record<string, unknown>; dir: string } | { unparseable: true } | null => {
  const loaded = loadOxlintConfig(projectDir)
  if (loaded.status === "missing") return null
  if (loaded.status === "ambiguous") return { unparseable: true }
  return { config: loaded.config, dir: projectDir }
}

/**
 * Composes the Lens plugin and rules into the project's oxlint config while
 * preserving its ignores, overrides, categories, and rule settings. Existing
 * `jsPlugins` paths are resolved to absolute (relative to the config dir) and
 * the Lens plugin is appended when not already present. Lens rules that the
 * project does not already set are added at their catalog severity; project
 * rule settings are never overridden.
 *
 * @since 0.0.0
 */
const composeConfig = (args: {
  configDir: string
  base: Record<string, unknown>
}): Record<string, unknown> => {
  const pluginPath = resolvePluginPath()
  const jsPlugins = Array.isArray(args.base.jsPlugins)
    ? args.base.jsPlugins.map((p) => (typeof p === "string" ? resolve(args.configDir, p) : p))
    : []
  if (!jsPlugins.includes(pluginPath)) jsPlugins.push(pluginPath)
  const baseRules = (args.base.rules ?? {}) as Record<string, unknown>
  const mergedRules: Record<string, unknown> = { ...baseRules }
  for (const rule of rules) {
    if (!(rule.id in mergedRules)) mergedRules[rule.id] = rule.severity
  }
  return { ...args.base, jsPlugins, rules: mergedRules }
}

/**
 * Prepares the oxlint config for a run: the built-in scratch config in
 * `lens-only` mode, or the composed project config (written to a transient
 * file in the project directory) in `unified` mode. Returns the config path,
 * its source, and the transient project path to clean up, or an error string
 * when the transient config could not be written.
 *
 * @since 0.0.0
 */
const prepareConfig = (args: {
  projectDir: string
  mode: CheckMode
  scratchDir: string
}):
  | {
    configPath: string
    configSource: ConfigSource
    projectConfigPath: string | null
    warning: string | null
  }
  | { error: string } =>
{
  if (args.mode === "lens-only") {
    const configPath = join(args.scratchDir, "oxlintrc.json")
    writeFileSync(configPath, JSON.stringify(buildConfig()))
    return { configPath, configSource: "builtin", projectConfigPath: null, warning: null }
  }
  const projectConfig = loadProjectConfig(args.projectDir)
  if (projectConfig === null) {
    const configPath = join(args.scratchDir, "oxlintrc.json")
    writeFileSync(configPath, JSON.stringify(buildConfig()))
    return { configPath, configSource: "builtin", projectConfigPath: null, warning: null }
  }
  if ("unparseable" in projectConfig) {
    const configPath = join(args.scratchDir, "oxlintrc.json")
    writeFileSync(configPath, JSON.stringify(buildConfig()))
    return {
      configPath,
      configSource: "builtin",
      projectConfigPath: null,
      warning: "project oxlint config could not be parsed; using the built-in config"
    }
  }
  const composed = composeConfig({ configDir: projectConfig.dir, base: projectConfig.config })
  const projectConfigPath = join(args.projectDir, transientConfigName())
  try {
    writeFileSync(projectConfigPath, JSON.stringify(composed))
  } catch (err) {
    return {
      error: `could not write transient oxlint config into the project: ${(err as Error).message}`
    }
  }
  return {
    configPath: projectConfigPath,
    configSource: "project",
    projectConfigPath,
    warning: null
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
 * Runs oxlint read-only over `targets` (files and/or directories) with the
 * Lens plugin loaded. Returns the parsed diagnostics plus a count of linted
 * files, or an error string when oxlint is unavailable or its output is
 * unparseable.
 *
 * @since 0.0.0
 */
export const runOxlint = (args: {
  projectDir: string
  targets: ReadonlyArray<string>
  mode?: CheckMode
}): OxlintRun => {
  const mode = args.mode ?? DEFAULT_CHECK_MODE
  const oxlintBin = resolveOxlintBin(args.projectDir)
  if (oxlintBin === null) {
    return {
      diagnostics: [],
      files: 0,
      error: "oxlint binary not found; install oxlint to run check",
      mode,
      configSource: "none",
      configWarning: null
    }
  }
  const scratchDir = mkdtempSync(join(tmpdir(), "effect-lens-check-"))
  const prepared = prepareConfig({ projectDir: args.projectDir, mode, scratchDir })
  if ("error" in prepared) {
    rmSync(scratchDir, { recursive: true, force: true })
    return {
      diagnostics: [],
      files: 0,
      error: prepared.error,
      mode,
      configSource: "none",
      configWarning: null
    }
  }
  const { configPath, configSource, projectConfigPath, warning } = prepared
  try {
    const result = spawnSync(
      oxlintBin,
      ["-c", configPath, "--format", "json", ...buildIgnorePatterns(), ...args.targets],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    )
    if (result.error !== undefined) {
      return {
        diagnostics: [],
        files: 0,
        error: `oxlint failed to start: ${result.error.message}`,
        mode,
        configSource,
        configWarning: warning
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
        error: `oxlint produced no JSON output${stderrNote}`,
        mode,
        configSource,
        configWarning: warning
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout.slice(jsonStart))
    } catch {
      return {
        diagnostics: [],
        files: 0,
        error: `oxlint produced unparseable output${stderrNote}`,
        mode,
        configSource,
        configWarning: warning
      }
    }
    const data = parsed as { diagnostics?: Array<unknown>; number_of_files?: unknown }
    const diagnostics = (data.diagnostics ?? [])
      .map((d) => decodeDiagnostic(d))
      .filter((d): d is Review.OxlintDiagnostic => d !== null)
    const files = typeof data.number_of_files === "number" ? data.number_of_files : 0
    return { diagnostics, files, error: null, mode, configSource, configWarning: warning }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
    if (projectConfigPath !== null) rmSync(projectConfigPath, { force: true })
  }
}
