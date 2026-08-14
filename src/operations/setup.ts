/**
 * Read-only `setup --dry-run` operation: build an ordered setup plan with no
 * mutations.
 *
 * The plan inspects the project's package manager, Effect dependency,
 * reference-pack state, oxlint/Lens configuration, and hook-manager state, and
 * returns an ordered list of steps. Each step is `ok`, `needed`, `unsupported`,
 * or `skip`. The operation never writes config, dependencies, packs, or hooks;
 * the mutating counterpart is `applySetupPlan` in `setupApply.ts` (used by
 * `setup --apply`).
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Diagnostic } from "../Finding.ts"
import type { PackageIdentity } from "../PackageIdentity.ts"
import type { PackVerificationResult } from "../PackVerifier.ts"
import * as PackVerifier from "../PackVerifier.ts"
import type { Resolution } from "../Resolver.ts"
import { resolveEffectIdentity } from "../Resolver.ts"
import {
  makeOxlintStatus,
  makeSetupPlan,
  makeSetupStep,
  OxlintStatus,
  SetupPlan,
  SetupStep
} from "../Setup.ts"
import * as Hooks from "./hooks.ts"
import { makeDiagnostic } from "./shared.ts"

/**
 * Reads and parses `package.json`, or `null` when absent or unparseable.
 *
 * @since 0.0.0
 */
const readPackageJson = (projectDir: string): Record<string, unknown> | null => {
  const path = join(projectDir, "package.json")
  if (!existsSync(path)) return null
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Detects the project's package manager from the lockfile or the
 * `packageManager` field, or `null` when none can be determined.
 *
 * @since 0.0.0
 */
const detectPackageManager = (projectDir: string, resolution: Resolution): string | null => {
  switch (resolution.lockfile) {
    case "package-lock":
      return "npm"
    case "pnpm-lock":
      return "pnpm"
    case "yarn-lock":
      return "yarn"
    case "bun-lock":
      return "bun"
    case "missing":
      break
  }
  const pkg = readPackageJson(projectDir)
  const pm = pkg?.packageManager
  if (typeof pm === "string" && pm !== "") {
    return pm.split("@")[0]
  }
  return null
}

/**
 * Inspects the project's oxlint / Lens configuration.
 *
 * A parseable `.oxlintrc.json` or `.oxlintrc` that references the Lens plugin
 * (`jsPlugins`) or `lens/` rules is `configured`; a parseable config without
 * Lens is `missing`; an unreadable or unparseable config is `ambiguous`.
 *
 * @since 0.0.0
 */
const oxlintStatus = (projectDir: string): OxlintStatus => {
  const relName = [".oxlintrc.json", ".oxlintrc"]
    .find((name) => existsSync(join(projectDir, name))) ?? null
  if (relName === null) {
    return makeOxlintStatus({ configPath: null, lensPluginConfigured: false, status: "missing" })
  }
  const file = join(projectDir, relName)
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return makeOxlintStatus({
      configPath: relName,
      lensPluginConfigured: false,
      status: "ambiguous"
    })
  }
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return makeOxlintStatus({
      configPath: relName,
      lensPluginConfigured: false,
      status: "ambiguous"
    })
  }
  const obj = (typeof data === "object" && data !== null
    ? data
    : {}) as Record<string, unknown>
  const jsPlugins = obj.jsPlugins
  const rules = obj.rules
  const lensPlugin = Array.isArray(jsPlugins) &&
    jsPlugins.some((p) => typeof p === "string" && p.includes("lens"))
  const lensRules = rules !== null &&
    typeof rules === "object" &&
    Object.keys(rules as Record<string, unknown>).some((key) => key.startsWith("lens/"))
  const configured = lensPlugin || lensRules
  return makeOxlintStatus({
    configPath: relName,
    lensPluginConfigured: configured,
    status: configured ? "configured" : "missing"
  })
}

/**
 * Builds the package-manager step.
 *
 * npm and pnpm are supported; yarn and bun are detected but unsupported; no
 * detected manager is unsupported because setup cannot proceed.
 *
 * @since 0.0.0
 */
const packageManagerStep = (packageManager: string | null): SetupStep => {
  if (packageManager === "npm" || packageManager === "pnpm") {
    return makeSetupStep({
      id: "package-manager",
      title: "Detect package manager",
      status: "ok",
      detail: `${packageManager} detected`
    })
  }
  if (packageManager === "yarn" || packageManager === "bun") {
    return makeSetupStep({
      id: "package-manager",
      title: "Detect package manager",
      status: "unsupported",
      detail: `${packageManager} lockfile detected but not supported`
    })
  }
  return makeSetupStep({
    id: "package-manager",
    title: "Detect package manager",
    status: "unsupported",
    detail: "no supported package manager detected"
  })
}

/**
 * Builds the Effect-dependency step from the resolution.
 *
 * @since 0.0.0
 */
const effectStep = (resolution: Resolution): SetupStep => {
  const expected = Option.getOrNull(resolution.expected)
  switch (resolution.status) {
    case "resolved":
      return makeSetupStep({
        id: "effect-dependency",
        title: "Resolve Effect dependency",
        status: "ok",
        detail: `effect ${expected?.version ?? "unknown"} resolved`
      })
    case "missing":
      return makeSetupStep({
        id: "effect-dependency",
        title: "Resolve Effect dependency",
        status: "needed",
        detail: "no effect dependency declared"
      })
    case "installed-mismatch":
      return makeSetupStep({
        id: "effect-dependency",
        title: "Resolve Effect dependency",
        status: "needed",
        detail: Option.getOrNull(resolution.detail) ??
          "installed effect does not match declared version"
      })
    case "missing-lockfile":
      return makeSetupStep({
        id: "effect-dependency",
        title: "Resolve Effect dependency",
        status: "needed",
        detail: Option.getOrNull(resolution.detail) ?? "no supported lockfile found"
      })
    case "unsupported-lockfile":
      return makeSetupStep({
        id: "effect-dependency",
        title: "Resolve Effect dependency",
        status: "unsupported",
        detail: Option.getOrNull(resolution.detail) ?? "unsupported lockfile detected"
      })
  }
}

/**
 * Builds the reference-pack step from the pack verification.
 *
 * @since 0.0.0
 */
const packStep = (pack: PackVerificationResult, resolution: Resolution): SetupStep => {
  if (resolution.status === "missing") {
    return makeSetupStep({
      id: "reference-pack",
      title: "Verify reference pack",
      status: "skip",
      detail: "no effect dependency; reference pack not applicable"
    })
  }
  switch (pack.status) {
    case "complete":
      return makeSetupStep({
        id: "reference-pack",
        title: "Verify reference pack",
        status: "ok",
        detail: "reference pack complete"
      })
    case "missing":
      return makeSetupStep({
        id: "reference-pack",
        title: "Verify reference pack",
        status: "needed",
        detail: Option.getOrNull(pack.message) ?? "no reference pack found"
      })
    case "stale":
      return makeSetupStep({
        id: "reference-pack",
        title: "Verify reference pack",
        status: "needed",
        detail: Option.getOrNull(pack.message) ?? "reference pack is stale"
      })
    case "partial":
      return makeSetupStep({
        id: "reference-pack",
        title: "Verify reference pack",
        status: "needed",
        detail: Option.getOrNull(pack.message) ?? "reference pack is partial"
      })
  }
}

/**
 * Builds the oxlint-config step.
 *
 * @since 0.0.0
 */
const oxlintStep = (oxlint: OxlintStatus): SetupStep => {
  switch (oxlint.status) {
    case "configured":
      return makeSetupStep({
        id: "oxlint-config",
        title: "Configure oxlint with Lens rules",
        status: "ok",
        detail: "oxlint configured with Lens plugin"
      })
    case "missing":
      return makeSetupStep({
        id: "oxlint-config",
        title: "Configure oxlint with Lens rules",
        status: "needed",
        detail: "no oxlint config with Lens rules found"
      })
    case "ambiguous":
      return makeSetupStep({
        id: "oxlint-config",
        title: "Configure oxlint with Lens rules",
        status: "unsupported",
        detail: "oxlint config present but unreadable or unparseable"
      })
  }
}

/**
 * Builds the hooks step from the aggregate hook-manager status.
 *
 * @since 0.0.0
 */
const hooksStep = (hooks: Hooks.HooksStatus): SetupStep => {
  switch (hooks.lensStatus) {
    case "installed":
      return makeSetupStep({
        id: "hooks",
        title: "Install Lens hook checks",
        status: "ok",
        detail: "effect-lens hook check installed"
      })
    case "absent":
      return makeSetupStep({
        id: "hooks",
        title: "Install Lens hook checks",
        status: "needed",
        detail: "no effect-lens hook check installed"
      })
    case "ambiguous":
      return makeSetupStep({
        id: "hooks",
        title: "Install Lens hook checks",
        status: "unsupported",
        detail: "hook-manager state is ambiguous"
      })
  }
}

/**
 * Derives the diagnostics that drive the exit code from the plan steps.
 *
 * A `needed` step is an advisory `warning`; an `unsupported` step is a
 * blocking `error`. `ok` and `skip` steps produce no diagnostic.
 *
 * @since 0.0.0
 */
const stepDiagnostics = (steps: Array<SetupStep>): Array<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = []
  for (const step of steps) {
    if (step.status === "needed") {
      diagnostics.push(
        makeDiagnostic({
          id: `setup-step-needed-${step.id}`,
          severity: "warning",
          message: Option.getOrNull(step.detail) ?? `${step.title}: action needed`
        })
      )
    } else if (step.status === "unsupported") {
      diagnostics.push(
        makeDiagnostic({
          id: `setup-step-unsupported-${step.id}`,
          severity: "error",
          message: Option.getOrNull(step.detail) ?? `${step.title}: unsupported`
        })
      )
    }
  }
  return diagnostics
}

/**
 * Builds a read-only {@link SetupPlan} for a project.
 *
 * @since 0.0.0
 */
export const buildSetupPlan = (args: {
  projectDir: string
  cacheDir: string
}): SetupPlan => {
  const resolution = resolveEffectIdentity(args.projectDir)
  const pack = PackVerifier.verifyReferencePack({
    projectDir: args.projectDir,
    cacheDir: args.cacheDir
  })
  const oxlint = oxlintStatus(args.projectDir)
  const hooks = Hooks.hooksStatus(args.projectDir)
  const packageManager = detectPackageManager(args.projectDir, resolution)
  const steps: Array<SetupStep> = [
    packageManagerStep(packageManager),
    effectStep(resolution),
    packStep(pack, resolution),
    oxlintStep(oxlint),
    hooksStep(hooks)
  ]
  const diagnostics = stepDiagnostics(steps)
  return makeSetupPlan({
    project: args.projectDir,
    packageManager,
    effect: Option.getOrNull(resolution.expected) as PackageIdentity | null,
    resolution,
    pack,
    oxlint,
    hooks,
    steps,
    diagnostics
  })
}

export { Hooks, OxlintStatus, SetupPlan, SetupStep }
export type { Diagnostic, PackageIdentity, PackVerificationResult, Resolution } from "../Setup.ts"
