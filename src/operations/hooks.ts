/**
 * Read-only `hooks status` operation: report the state of known hook managers
 * and whether an `effect-lens` check is installed.
 *
 * Lens integrates with existing hook managers instead of overwriting them, so
 * this operation inspects each known manager's config file (or `package.json`
 * field) and reports whether it references `effect-lens`. Detection is
 * content-based and deterministic: a present, readable config that references
 * `effect-lens` is `installed`; a present, readable config that does not is
 * `absent`; a present config that cannot be read or parsed is `ambiguous`. The
 * operation never writes hook files or configuration.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Diagnostic } from "../Finding.ts"
import {
  HookManagerName,
  HookManagerStatus,
  HooksStatus,
  LensInstallStatus,
  makeHookManagerStatus,
  makeHooksStatus
} from "../Hooks.ts"
import { makeDiagnostic } from "./shared.ts"

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
 * Reads and parses `package.json`.
 *
 * Returns `{ data, readable }` where `data` is the parsed object (or `null`
 * when absent) and `readable` is `false` when the file exists but cannot be
 * read or parsed. Callers treat an unreadable `package.json` as `ambiguous`
 * rather than silently absent.
 *
 * @since 0.0.0
 */
const readPackageJson = (projectDir: string): {
  data: Record<string, unknown> | null
  readable: boolean
} => {
  const path = join(projectDir, "package.json")
  if (!existsSync(path)) return { data: null, readable: true }
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return { data: null, readable: false }
  }
  try {
    const data: unknown = JSON.parse(content)
    if (typeof data === "object" && data !== null) {
      return { data: data as Record<string, unknown>, readable: true }
    }
    return { data: null, readable: false }
  } catch {
    return { data: null, readable: false }
  }
}

/**
 * Scans a husky directory for hook files that reference `effect-lens`.
 *
 * Any readable hook file (pre-commit, pre-push, etc.) that references
 * `effect-lens` counts as installed; an unreadable hook file is `ambiguous`;
 * otherwise the hooks are `absent`.
 *
 * @since 0.0.0
 */
const scanHusky = (huskyDir: string): {
  installed: boolean
  ambiguous: boolean
  anyFile: boolean
} => {
  let installed = false
  let ambiguous = false
  let anyFile = false
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      ambiguous = true
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        anyFile = true
        const content = readText(path)
        if (content === null) {
          ambiguous = true
        } else if (content.includes("effect-lens")) {
          installed = true
        }
      }
    }
  }
  walk(huskyDir)
  return { installed, ambiguous, anyFile }
}

/**
 * Inspects the husky hook manager.
 *
 * Husky is detected by a `.husky/` directory or a legacy `husky` field in
 * `package.json`. Any readable hook file under `.husky/` that references
 * `effect-lens` counts as installed; the legacy `husky.hooks` config is read
 * from `package.json`. A non-object `husky` field or an unreadable
 * `package.json` is `ambiguous`.
 *
 * @since 0.0.0
 */
const huskyStatus = (projectDir: string): HookManagerStatus => {
  const huskyDir = join(projectDir, ".husky")
  const pkg = readPackageJson(projectDir)
  const legacy = pkg.data?.husky
  const legacyObject = legacy !== undefined && legacy !== null && typeof legacy === "object"
  const dirPresent = existsSync(huskyDir)

  if (dirPresent) {
    const preCommitPath = join(huskyDir, "pre-commit")
    if (existsSync(preCommitPath) && statSync(preCommitPath).isDirectory()) {
      return makeHookManagerStatus({
        manager: "husky",
        present: true,
        configPath: ".husky/pre-commit",
        lensStatus: "ambiguous",
        detail: "husky pre-commit hook path is a directory"
      })
    }
    const scan = scanHusky(huskyDir)
    if (scan.installed) {
      return makeHookManagerStatus({
        manager: "husky",
        present: true,
        configPath: ".husky",
        lensStatus: "installed",
        detail: "a husky hook references effect-lens"
      })
    }
    if (scan.ambiguous) {
      return makeHookManagerStatus({
        manager: "husky",
        present: true,
        configPath: ".husky",
        lensStatus: "ambiguous",
        detail: "a husky hook is present but unreadable"
      })
    }
    if (scan.anyFile) {
      return makeHookManagerStatus({
        manager: "husky",
        present: true,
        configPath: ".husky",
        lensStatus: "absent",
        detail: "husky hooks present but none reference effect-lens"
      })
    }
    return makeHookManagerStatus({
      manager: "husky",
      present: true,
      configPath: ".husky",
      lensStatus: "absent",
      detail: "husky directory present but no hook files found"
    })
  }

  if (legacyObject) {
    const hooks = (legacy as Record<string, unknown>).hooks as
      | Record<string, unknown>
      | undefined
    const preCommit = hooks?.preCommit ?? hooks?.["pre-commit"]
    if (typeof preCommit === "string") {
      const installed = preCommit.includes("effect-lens")
      return makeHookManagerStatus({
        manager: "husky",
        present: true,
        configPath: "package.json",
        lensStatus: installed ? "installed" : "absent",
        detail: installed
          ? "husky package.json pre-commit references effect-lens"
          : "husky package.json pre-commit does not reference effect-lens"
      })
    }
    return makeHookManagerStatus({
      manager: "husky",
      present: true,
      configPath: "package.json",
      lensStatus: "absent",
      detail: "husky configured in package.json but no pre-commit hook references effect-lens"
    })
  }

  if (legacy !== undefined) {
    return makeHookManagerStatus({
      manager: "husky",
      present: true,
      configPath: "package.json",
      lensStatus: "ambiguous",
      detail: "husky field in package.json is not an object"
    })
  }

  if (!pkg.readable) {
    return makeHookManagerStatus({
      manager: "husky",
      present: true,
      configPath: "package.json",
      lensStatus: "ambiguous",
      detail: "package.json present but unreadable or unparseable"
    })
  }

  return makeHookManagerStatus({
    manager: "husky",
    present: false,
    configPath: null,
    lensStatus: "absent",
    detail: "husky not detected"
  })
}

/**
 * Inspects a YAML-file-based hook manager (lefthook or pre-commit).
 *
 * The manager is detected by a known config file. A present, readable config
 * that references `effect-lens` is `installed`; a readable config that does
 * not is `absent`; an unreadable config is `ambiguous`. `configPath` is the
 * project-relative file name.
 *
 * @since 0.0.0
 */
const yamlFileStatus = (
  projectDir: string,
  manager: "lefthook" | "pre-commit",
  candidates: Array<string>
): HookManagerStatus => {
  const relName = candidates.find((name) => existsSync(join(projectDir, name))) ?? null
  if (relName === null) {
    return makeHookManagerStatus({
      manager,
      present: false,
      configPath: null,
      lensStatus: "absent",
      detail: `${manager} not detected`
    })
  }
  const content = readText(join(projectDir, relName))
  if (content === null) {
    return makeHookManagerStatus({
      manager,
      present: true,
      configPath: relName,
      lensStatus: "ambiguous",
      detail: `${manager} config present but unreadable`
    })
  }
  const installed = content.includes("effect-lens")
  return makeHookManagerStatus({
    manager,
    present: true,
    configPath: relName,
    lensStatus: installed ? "installed" : "absent",
    detail: installed
      ? `${manager} config references effect-lens`
      : `${manager} config does not reference effect-lens`
  })
}

/**
 * Inspects a `package.json`-field-based hook manager (lint-staged or
 * simple-git-hooks).
 *
 * The manager is detected by its field in `package.json`. A config that
 * references `effect-lens` is `installed`; otherwise it is `absent`. An
 * unreadable or unparseable `package.json` is `ambiguous`.
 *
 * @since 0.0.0
 */
const packageJsonFieldStatus = (
  projectDir: string,
  manager: "lint-staged" | "simple-git-hooks"
): HookManagerStatus => {
  const pkg = readPackageJson(projectDir)
  if (!pkg.readable) {
    return makeHookManagerStatus({
      manager,
      present: true,
      configPath: "package.json",
      lensStatus: "ambiguous",
      detail: "package.json present but unreadable or unparseable"
    })
  }
  const config = pkg.data?.[manager]
  if (config === undefined) {
    return makeHookManagerStatus({
      manager,
      present: false,
      configPath: null,
      lensStatus: "absent",
      detail: `${manager} not detected`
    })
  }
  const installed = JSON.stringify(config).includes("effect-lens")
  return makeHookManagerStatus({
    manager,
    present: true,
    configPath: "package.json",
    lensStatus: installed ? "installed" : "absent",
    detail: installed
      ? `${manager} config references effect-lens`
      : `${manager} config does not reference effect-lens`
  })
}

/**
 * Builds the aggregate {@link HooksStatus} for a project.
 *
 * `lensStatus` is `installed` when any manager has an `effect-lens` check,
 * `ambiguous` when any manager is ambiguous and none is installed, and
 * `absent` otherwise. The exit-code-driving diagnostics reflect the aggregate
 * `lensStatus` only: `absent` and `ambiguous` produce a single `warning`, while
 * per-manager details are `off` notes so a present sibling without `effect-lens`
 * never downgrades an installed aggregate to a warning.
 *
 * @since 0.0.0
 */
export const hooksStatus = (projectDir: string): HooksStatus => {
  const managers: Array<HookManagerStatus> = [
    huskyStatus(projectDir),
    yamlFileStatus(projectDir, "lefthook", ["lefthook.yml", "lefthook.yaml"]),
    yamlFileStatus(projectDir, "pre-commit", [
      ".pre-commit-config.yaml",
      ".pre-commit-config.yml"
    ]),
    packageJsonFieldStatus(projectDir, "lint-staged"),
    packageJsonFieldStatus(projectDir, "simple-git-hooks")
  ]

  let lensStatus: LensInstallStatus
  if (managers.some((m) => m.lensStatus === "installed")) {
    lensStatus = "installed"
  } else if (managers.some((m) => m.lensStatus === "ambiguous")) {
    lensStatus = "ambiguous"
  } else {
    lensStatus = "absent"
  }

  const diagnostics: Array<Diagnostic> = []
  for (const m of managers) {
    if (!m.present) continue
    if (m.lensStatus === "ambiguous") {
      diagnostics.push(
        makeDiagnostic({
          id: `hooks-ambiguous-${m.manager}`,
          severity: "off",
          message: Option.getOrNull(m.detail) ?? `${m.manager} hook state is ambiguous`
        })
      )
    } else if (m.lensStatus === "absent") {
      diagnostics.push(
        makeDiagnostic({
          id: `hooks-lens-not-installed-${m.manager}`,
          severity: "off",
          message: Option.getOrNull(m.detail) ??
            `${m.manager} present but effect-lens not installed`
        })
      )
    }
  }
  if (lensStatus === "absent") {
    diagnostics.push(
      makeDiagnostic({
        id: "hooks-lens-not-installed",
        severity: "warning",
        message: "no effect-lens hook check is installed"
      })
    )
  } else if (lensStatus === "ambiguous") {
    diagnostics.push(
      makeDiagnostic({
        id: "hooks-ambiguous",
        severity: "warning",
        message: "hook-manager state is ambiguous"
      })
    )
  }

  return makeHooksStatus({ lensStatus, managers, diagnostics })
}

export { HookManagerName, HookManagerStatus, HooksStatus, LensInstallStatus }
export type { Diagnostic } from "../Finding.ts"
