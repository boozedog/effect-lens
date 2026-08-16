/**
 * Shared oxlint configuration loading for the read-only core operations.
 *
 * Both `setup` (`oxlintStatus`) and `adoption` (`detectOxlintScopes`) inspect
 * the project's oxlint config, so the supported config file names and the
 * parse/normalize rules live here as a single source of truth rather than
 * being duplicated per operation. Loading is read-only and offline: it never
 * writes or rewrites the project's config.
 *
 * @since 0.0.0
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The oxlint config file names, in precedence order.
 *
 * @since 0.0.0
 */
export const OXLINT_CONFIG_NAMES = [".oxlintrc.json", ".oxlintrc", "oxlint.json"]

/**
 * The result of loading a project's oxlint config.
 *
 * - `missing` — no supported config file is present.
 * - `present` — a config file exists and parses to a plain object.
 * - `ambiguous` — a config file exists but is unreadable, unparseable, or
 *   parses to a non-object value (e.g. valid JSON `null`), so its scopes and
 *   rules cannot be trusted.
 *
 * @since 0.0.0
 */
export type OxlintConfigLoad =
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly status: "ambiguous"; readonly name: string }

/**
 * Loads and parses the project's oxlint config, normalizing non-object values
 * (including valid JSON `null`) to `ambiguous` so downstream inspection never
 * crashes on a `null` config.
 *
 * @since 0.0.0
 */
export const loadOxlintConfig = (projectDir: string): OxlintConfigLoad => {
  for (const name of OXLINT_CONFIG_NAMES) {
    const path = join(projectDir, name)
    if (!existsSync(path)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { status: "ambiguous", name }
      }
      return { status: "present", name, config: parsed as Record<string, unknown> }
    } catch {
      return { status: "ambiguous", name }
    }
  }
  return { status: "missing" }
}

/**
 * Whether a `jsPlugins` entry matches `needle`. A string entry matches when it
 * contains the needle; an object entry (e.g. Foldstryx's
 * `{ name: "stylex", specifier: "@stylexjs/eslint-plugin" }`) matches when its
 * `name` or `specifier` contains the needle.
 *
 * @since 0.0.0
 */
export const jsPluginMatches = (jsPlugins: unknown, needle: string): boolean => {
  if (!Array.isArray(jsPlugins)) return false
  return jsPlugins.some((p) => {
    if (typeof p === "string") return p.includes(needle)
    if (typeof p === "object" && p !== null) {
      const entry = p as Record<string, unknown>
      const name = typeof entry.name === "string" ? entry.name : ""
      const specifier = typeof entry.specifier === "string" ? entry.specifier : ""
      return name.includes(needle) || specifier.includes(needle)
    }
    return false
  })
}
