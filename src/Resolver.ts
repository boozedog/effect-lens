/**
 * Resolution of the project's expected Effect package identity from committed
 * project metadata (lockfile / `package.json`) and verification against the
 * installed package.
 *
 * Precedence for the *expected* identity (reproducible, committed metadata):
 * 1. `package-lock.json` (npm) — preferred when present.
 * 2. `pnpm-lock.yaml` (pnpm) — preferred when present.
 * 3. `package.json` declared `effect` specifier — fallback when no supported
 *    lockfile is present or the lockfile has no `effect` entry.
 *
 * `yarn.lock` and `bun.lock`/`bun.lockb` are detected but reported as
 * `unsupported` rather than guessed at. The installed package
 * (`node_modules/effect/package.json`) is used only for verification, never
 * as the source of the expected identity.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { makePackageIdentity, PackageIdentity, samePackage } from "./PackageIdentity.ts"

/**
 * Which lockfile (if any) is present in the project. `package-lock` and
 * `pnpm-lock` are supported; `yarn-lock` and `bun-lock` are detected but not
 * parsed.
 *
 * @since 0.0.0
 */
export const LockfileKind = Schema.Literals([
  "package-lock",
  "pnpm-lock",
  "yarn-lock",
  "bun-lock",
  "missing"
])
export type LockfileKind = Schema.Schema.Type<typeof LockfileKind>

/**
 * The overall outcome of resolving the expected Effect identity.
 *
 * - `resolved` — expected identity derived from a supported lockfile and the
 *   installed package (when present) matches.
 * - `installed-mismatch` — expected identity derived, but the installed
 *   package version differs (a declared-vs-installed conflict).
 * - `missing-lockfile` — no supported lockfile found; expected identity came
 *   from `package.json`.
 * - `unsupported-lockfile` — a lockfile exists but is not supported; expected
 *   identity came from `package.json`.
 * - `missing` — no `effect` dependency is declared in any committed metadata.
 *
 * @since 0.0.0
 */
export const ResolutionStatus = Schema.Literals([
  "resolved",
  "installed-mismatch",
  "missing-lockfile",
  "unsupported-lockfile",
  "missing"
])
export type ResolutionStatus = Schema.Schema.Type<typeof ResolutionStatus>

/**
 * The result of resolving a project's Effect dependency identity.
 *
 * `expected` is the identity derived from committed metadata (lockfile or
 * `package.json`); `installed` is what is on disk under
 * `node_modules/effect/package.json` (when present). `lockfile` records which
 * lockfile was detected, and `status` summarises the relationship.
 *
 * @since 0.0.0
 */
export class Resolution extends Schema.Class<Resolution>("Resolution")({
  expected: Schema.OptionFromNullOr(PackageIdentity),
  installed: Schema.OptionFromNullOr(PackageIdentity),
  lockfile: LockfileKind,
  status: ResolutionStatus,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * Constructs a {@link Resolution} value.
 *
 * @since 0.0.0
 */
export const makeResolution = (args: {
  expected?: PackageIdentity | null
  installed?: PackageIdentity | null
  lockfile: LockfileKind
  status: ResolutionStatus
  detail?: string | null
}): Resolution =>
  new Resolution({
    expected: Option.fromNullishOr(args.expected),
    installed: Option.fromNullishOr(args.installed),
    lockfile: args.lockfile,
    status: args.status,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * Parses an npm `package-lock.json` (v2/v3) and returns the direct `effect`
 * package identity, or `null` when the lockfile has no direct `effect` entry.
 * Only a dependency declared at the root (`packages[""]`) is treated as the
 * project's direct `effect`; a transitive hoisted copy is not.
 *
 * @since 0.0.0
 */
export const parsePackageLock = (content: string): PackageIdentity | null => {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  const packages = (data as { packages?: Record<string, unknown> })?.packages
  if (!packages || typeof packages !== "object") return null
  const root = packages[""] as
    | { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    | undefined
  const rootDeps = {
    ...root?.dependencies,
    ...root?.devDependencies
  }
  if (typeof rootDeps.effect !== "string") return null
  const entry = packages["node_modules/effect"] as
    | { version?: unknown; integrity?: unknown }
    | undefined
  if (!entry || typeof entry !== "object") return null
  const version = entry.version
  if (typeof version !== "string" || version === "") return null
  const integrity = typeof entry.integrity === "string" ? entry.integrity : null
  return makePackageIdentity({ name: "effect", version, source: "lockfile", integrity })
}

/**
 * True when an npm `package-lock.json` is structurally parseable JSON.
 *
 * @since 0.0.0
 */
export const isParseablePackageLock = (content: string): boolean => {
  try {
    JSON.parse(content)
    return true
  } catch {
    return false
  }
}

/**
 * True when a `pnpm-lock.yaml` has the supported shape (an `importers`
 * section). Older pnpm lockfiles (v6 string dependencies) and other shapes are
 * reported as unparseable rather than guessed at.
 *
 * @since 0.0.0
 */
export const isParseablePnpmLock = (content: string): boolean => {
  const parsed = parseYamlSubset(content)
  return parsed.importers !== undefined && typeof parsed.importers === "object"
}

/**
 * Parses a `pnpm-lock.yaml` and returns the direct `effect` package identity,
 * or `null` when the lockfile has no `effect` entry. Uses a minimal YAML
 * subset parser sufficient for the lockfile shape; duplicate keys (which pnpm
 * emits for a package's `resolution` and `dependencies` blocks) are merged.
 *
 * @since 0.0.0
 */
export const parsePnpmLock = (content: string): PackageIdentity | null => {
  const parsed = parseYamlSubset(content)
  const importers = parsed.importers
  if (!importers || typeof importers !== "object") return null
  const root = (importers as Record<string, unknown>)["."]
  if (!root || typeof root !== "object") return null
  const deps = {
    ...((root as Record<string, unknown>).dependencies as Record<string, unknown> | undefined),
    ...((root as Record<string, unknown>).devDependencies as Record<string, unknown> | undefined)
  }
  const effect = deps.effect
  if (!effect || typeof effect !== "object") return null
  const version = (effect as Record<string, unknown>).version
  if (typeof version !== "string" || version === "") return null

  let integrity: string | null = null
  const packages = parsed.packages
  if (packages && typeof packages === "object") {
    const entry = (packages as Record<string, unknown>)[`effect@${version}`]
    if (entry && typeof entry === "object") {
      const resolution = (entry as Record<string, unknown>).resolution
      if (resolution && typeof resolution === "object") {
        const int = (resolution as Record<string, unknown>).integrity
        if (typeof int === "string") integrity = int
      }
    }
  }
  return makePackageIdentity({ name: "effect", version, source: "lockfile", integrity })
}

/**
 * Parses a `package.json` and returns the declared `effect` specifier as a
 * package identity (source `package.json`), or `null` when `effect` is not
 * declared. The specifier may be a range (e.g. `^4.0.0`); it is recorded
 * verbatim as the declared intent.
 *
 * @since 0.0.0
 */
export const parsePackageJson = (content: string): PackageIdentity | null => {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  const deps = {
    ...(data as { dependencies?: Record<string, unknown> })?.dependencies,
    ...(data as { devDependencies?: Record<string, unknown> })?.devDependencies
  }
  const spec = deps.effect
  if (typeof spec !== "string" || spec === "") return null
  return makePackageIdentity({ name: "effect", version: spec, source: "package.json" })
}

/**
 * Parses an installed `node_modules/effect/package.json` into a package
 * identity (source `installed`), or `null` when it is not an `effect` package.
 *
 * @since 0.0.0
 */
export const parseInstalledPackageJson = (content: string): PackageIdentity | null => {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  const name = (data as { name?: unknown })?.name
  const version = (data as { version?: unknown })?.version
  if (name !== "effect" || typeof version !== "string" || version === "") return null
  return makePackageIdentity({ name: "effect", version, source: "installed" })
}

/**
 * Detects which lockfile (if any) is present in a project directory.
 *
 * @since 0.0.0
 */
export const detectLockfile = (projectDir: string): LockfileKind => {
  const has = (file: string): boolean => existsSync(join(projectDir, file))
  if (has("package-lock.json")) return "package-lock"
  if (has("pnpm-lock.yaml")) return "pnpm-lock"
  if (has("yarn.lock")) return "yarn-lock"
  if (has("bun.lock") || has("bun.lockb")) return "bun-lock"
  return "missing"
}

/**
 * Reads the installed `effect` package identity from
 * `node_modules/effect/package.json`, or `null` when it is absent or invalid.
 *
 * @since 0.0.0
 */
export const readInstalledEffect = (projectDir: string): PackageIdentity | null => {
  const path = join(projectDir, "node_modules", "effect", "package.json")
  if (!existsSync(path)) return null
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  return parseInstalledPackageJson(content)
}

/**
 * Resolves the project's expected Effect package identity from committed
 * metadata and verifies it against the installed package.
 *
 * @since 0.0.0
 */
export const resolveEffectIdentity = (projectDir: string): Resolution => {
  const lockfile = detectLockfile(projectDir)
  const installed = readInstalledEffect(projectDir)

  let expected: PackageIdentity | null = null
  let detail: string | null = null
  let lockfileUnparseable = false

  if (lockfile === "package-lock") {
    const content = readFileSync(join(projectDir, "package-lock.json"), "utf8")
    if (isParseablePackageLock(content)) {
      expected = parsePackageLock(content)
      if (!expected) detail = "package-lock.json present but no direct effect entry found"
    } else {
      lockfileUnparseable = true
      detail = "package-lock.json present but could not be parsed"
    }
  } else if (lockfile === "pnpm-lock") {
    const content = readFileSync(join(projectDir, "pnpm-lock.yaml"), "utf8")
    if (isParseablePnpmLock(content)) {
      expected = parsePnpmLock(content)
      if (!expected) detail = "pnpm-lock.yaml present but no effect entry found"
    } else {
      lockfileUnparseable = true
      detail = "pnpm-lock.yaml present but could not be parsed (unsupported shape)"
    }
  }

  if (!expected) {
    const packageJsonPath = join(projectDir, "package.json")
    if (existsSync(packageJsonPath)) {
      expected = parsePackageJson(readFileSync(packageJsonPath, "utf8"))
    }
  }

  let status: ResolutionStatus
  if (!expected) {
    status = "missing"
    detail = detail ?? "no effect dependency declared in lockfile or package.json"
  } else if (lockfile === "yarn-lock" || lockfile === "bun-lock") {
    status = "unsupported-lockfile"
    detail = `${lockfile} detected but not supported; expected identity from package.json`
  } else if (lockfile === "missing") {
    status = "missing-lockfile"
    detail = "no supported lockfile found; expected identity from package.json"
  } else if (lockfileUnparseable) {
    // A supported lockfile is present but unusable. The expected identity came
    // from package.json; do not compare a (possibly range) specifier to the
    // installed exact version.
    status = "missing-lockfile"
    detail = detail ??
      "lockfile present but could not be parsed; expected identity from package.json"
  } else if (
    expected.source === "lockfile" && installed !== null && !samePackage(expected, installed)
  ) {
    status = "installed-mismatch"
    detail = `installed effect ${installed.version} does not match expected ${expected.version}`
  } else {
    status = "resolved"
  }

  return makeResolution({ expected, installed, lockfile, status, detail })
}

/**
 * A minimal YAML subset parser sufficient for `pnpm-lock.yaml`. Handles nested
 * mappings by indentation, scalar values, inline flow maps (`{a: b}`), quoted
 * keys/values, comments, and merges duplicate keys (which pnpm emits). It is
 * not a general YAML parser and MUST NOT be used outside the lockfile shape.
 *
 * @internal
 */
const parseYamlSubset = (content: string): Record<string, unknown> => {
  const lines: Array<{ indent: number; text: string }> = []
  for (const raw of content.split("\n")) {
    const noComment = raw.replace(/#.*$/, "").trimEnd()
    if (noComment.trim() === "") continue
    const indent = noComment.length - noComment.trimStart().length
    lines.push({ indent, text: noComment.trim() })
  }
  const [root] = parseBlock(lines, 0, 0)
  return root
}

const parseBlock = (
  lines: Array<{ indent: number; text: string }>,
  start: number,
  indent: number
): [Record<string, unknown>, number] => {
  const result: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      i++
      continue
    }
    const colon = line.text.indexOf(":")
    if (colon === -1) {
      i++
      continue
    }
    const key = unquote(line.text.slice(0, colon).trim())
    const rest = line.text.slice(colon + 1).trim()
    if (rest === "") {
      let childIndent = indent + 2
      let j = i + 1
      while (j < lines.length && lines[j].indent <= indent) j++
      if (j < lines.length) childIndent = lines[j].indent
      const [child, next] = parseBlock(lines, i + 1, childIndent)
      result[key] = mergeValue(result[key], child)
      i = next
    } else if (rest.startsWith("{")) {
      result[key] = parseFlowMap(rest)
      i++
    } else {
      result[key] = parseScalar(rest)
      i++
    }
  }
  return [result, i]
}

const parseFlowMap = (text: string): Record<string, unknown> => {
  const inner = text.slice(1, text.lastIndexOf("}")).trim()
  const result: Record<string, unknown> = {}
  if (inner === "") return result
  for (const part of inner.split(",")) {
    const colon = part.indexOf(":")
    if (colon === -1) continue
    const key = unquote(part.slice(0, colon).trim())
    result[key] = parseScalar(part.slice(colon + 1).trim())
  }
  return result
}

const parseScalar = (raw: string): string | number | boolean | null => {
  const value = raw.trim()
  if (value === "null" || value === "~") return null
  if (value === "true") return true
  if (value === "false") return false
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

const unquote = (key: string): string => {
  if (key.startsWith("\"") && key.endsWith("\"")) return key.slice(1, -1)
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1)
  return key
}

const mergeValue = (existing: unknown, incoming: unknown): unknown => {
  if (
    existing !== null &&
    typeof existing === "object" &&
    incoming !== null &&
    typeof incoming === "object" &&
    !Array.isArray(existing) &&
    !Array.isArray(incoming)
  ) {
    return { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) }
  }
  return incoming
}
