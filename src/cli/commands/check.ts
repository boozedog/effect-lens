/**
 * `effect-lens check`: run the available local read-only review path and
 * aggregate findings and diagnostics into a {@link MachineOutput}.
 *
 * Check runs oxlint (with the Lens plugin loaded) over the resolved scope,
 * feeds the JSON diagnostics into the shared-core `review` operation, and
 * aggregates the resulting findings and diagnostics. In `lens-only` mode (the
 * default) a fresh scratch config is used; in `unified` mode the target
 * repository's oxlint config is preserved while the Lens rules are loaded. It
 * is read-only: it never mutates source, caches, or the project's own
 * configuration (in `unified` mode it writes a transient sidecar config that
 * is removed in a `finally` block). If oxlint is unavailable, a diagnostic is
 * emitted instead of crashing.
 *
 * The lint scope is one of:
 * - `project` (default) — the whole repository root, or only the selected
 *   workspace's tree when `--workspace` is supplied (the root remains the
 *   config/lockfile boundary).
 * - `path` — an explicit `--path` file or directory relative to the project.
 * - `changed` (`--changed`) — the staged changed-file scope, optionally
 *   filtered to a selected `--workspace`. Changed files are read from Git
 *   (`git diff --cached --name-only --diff-filter=ACMR`) by the reusable
 *   {@link resolveChangedFiles} resolver, so deleted and unstaged-only files
 *   are excluded and the repository-root config/lockfile boundary is
 *   preserved while linting only the selected workspace's staged files.
 *   A scope with no matching staged files is a clean no-op with an explicit
 *   report.
 *
 * A full-check `--workspace` target that matches no single lockfile importer
 * (invalid or ambiguous) blocks the run with an `error` diagnostic before
 * oxlint is invoked, rather than silently scanning the repository root. This
 * full-check rejection does not apply to `--changed`, which keeps its existing
 * empty-scope no-op behavior. When both `--workspace` and `--path` are
 * supplied, `--path` wins for the lint scope.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { resolve } from "node:path"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import type { Diagnostic } from "../../Finding.ts"
import * as Review from "../../operations/review.ts"
import { makeDiagnostic } from "../../operations/shared.ts"
import { type CheckMode, DEFAULT_CHECK_MODE } from "../../provider/Provider.ts"
import { resolveWorkspaceTarget } from "../../Resolver.ts"
import { resolveChangedFiles } from "../changed.ts"
import { encode } from "../encode.ts"
import { runOxlint } from "../oxlint.ts"
import type { CliResult } from "../types.ts"

/**
 * The resolved lint scope for a `check` run.
 *
 * - `project` — the whole repository root (the default), or only the selected
 *   workspace's tree when `--workspace` is supplied. The repository root
 *   remains the config/lockfile boundary.
 * - `path` — an explicit `--path` file or directory relative to the project.
 *   When both `--workspace` and `--path` are supplied, `--path` wins for the
 *   lint scope.
 * - `changed` — the staged changed-file scope (`--changed`), optionally
 *   filtered to a selected workspace.
 *
 * @since 0.0.0
 */
export type CheckScope =
  | {
    readonly kind: "project"
    readonly workspace: string | null
    readonly workspaceDir: string | null
    readonly error: string | null
    readonly errorKind: "ambiguous" | "unresolved" | null
  }
  | { readonly kind: "path"; readonly path: string; readonly workspace: string | null }
  | {
    readonly kind: "changed"
    readonly workspace: string | null
    readonly files: Array<string>
    readonly error: string | null
  }

/**
 * Runs the read-only `check` command.
 *
 * @since 0.0.0
 */
export const check = (args: {
  projectDir: string
  cacheDir: string
  path?: string
  mode?: CheckMode
  workspace?: string | undefined
  changed?: boolean
}): CliResult => {
  const mode = args.mode ?? DEFAULT_CHECK_MODE
  const scope = buildScope(args)
  const diagnostics: Array<Diagnostic> = []
  let oxlint: ReturnType<typeof runOxlint>
  if (
    (scope.kind === "changed" && scope.files.length === 0) ||
    (scope.kind === "project" && scope.error !== null)
  ) {
    // A changed scope with no matching files is a clean no-op, and a project
    // scope whose workspace target failed to resolve is a blocking error. In
    // both cases oxlint is not spawned.
    oxlint = {
      diagnostics: [],
      files: 0,
      error: null,
      mode,
      configSource: "none",
      configWarning: null
    }
  } else {
    oxlint = runOxlint({
      projectDir: args.projectDir,
      targets: targetsOf(args.projectDir, scope),
      mode
    })
  }
  if (scope.kind === "project" && scope.error !== null) {
    // An invalid or ambiguous workspace target is a blocking diagnostic that
    // prevents any lint run: the root is never silently scanned instead.
    diagnostics.push(
      makeDiagnostic({
        id: scope.errorKind === "ambiguous"
          ? "check-workspace-ambiguous"
          : "check-workspace-unresolved",
        severity: "error",
        message: scope.error
      })
    )
  }
  if (scope.kind === "changed" && scope.error !== null) {
    diagnostics.push(
      makeDiagnostic({
        id: "check-changed-scope-unavailable",
        severity: "warning",
        message: scope.error
      })
    )
  }
  if (oxlint.error !== null) {
    diagnostics.push(
      makeDiagnostic({
        id: "check-oxlint-unavailable",
        severity: "warning",
        message: oxlint.error
      })
    )
  }
  if (oxlint.configWarning !== null) {
    diagnostics.push(
      makeDiagnostic({
        id: "check-config-unparseable",
        severity: "warning",
        message: oxlint.configWarning
      })
    )
  }
  const review = Review.review({
    input: Review.makeReviewInput({ diagnostics: oxlint.diagnostics }),
    mode
  })
  const allDiagnostics = [...review.diagnostics, ...diagnostics]
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: review.findings, diagnostics: allDiagnostics }),
    findings: [...review.findings],
    diagnostics: allDiagnostics
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      review: encode(Review.ReviewResult, review),
      scope: scopeJson(scope),
      oxlint: {
        files: oxlint.files,
        error: oxlint.error,
        mode,
        changed: scope.kind === "changed",
        config: oxlint.configSource,
        configWarning: oxlint.configWarning
      }
    },
    human: buildHuman({ review, oxlint, diagnostics: allDiagnostics, mode, scope })
  }
}

/**
 * Resolves the lint scope from the `check` args: `--changed` selects the
 * staged changed-file scope, `--path` an explicit file/directory, otherwise
 * the whole project tree.
 *
 * @since 0.0.0
 */
const buildScope = (args: {
  projectDir: string
  path?: string
  workspace?: string | undefined
  changed?: boolean
}): CheckScope => {
  const workspace = args.workspace ?? null
  if (args.changed === true) {
    const resolved = resolveChangedFiles({
      projectDir: args.projectDir,
      workspace: args.workspace
    })
    return {
      kind: "changed",
      workspace,
      files: resolved.files,
      error: resolved.error
    }
  }
  if (args.path !== undefined) {
    return { kind: "path", path: args.path, workspace }
  }
  // Full-check `--workspace`: resolve the target to a concrete repo-relative
  // directory so the run lints only the selected workspace while keeping the
  // repository root as the config/lockfile boundary. An invalid or ambiguous
  // target is a blocking diagnostic (no lint run) rather than a silent root
  // scan or a clean result.
  if (workspace !== null) {
    const target = resolveWorkspaceTarget(args.projectDir, workspace)
    if (target.kind === "ok") {
      return {
        kind: "project",
        workspace,
        workspaceDir: target.dir,
        error: null,
        errorKind: null
      }
    }
    return {
      kind: "project",
      workspace,
      workspaceDir: null,
      error: target.detail,
      errorKind: target.kind
    }
  }
  return { kind: "project", workspace: null, workspaceDir: null, error: null, errorKind: null }
}

/**
 * The lint targets for a scope: the changed files for `changed`, the resolved
 * `--path`, or the project directory.
 *
 * @since 0.0.0
 */
const targetsOf = (projectDir: string, scope: CheckScope): Array<string> => {
  switch (scope.kind) {
    case "changed":
      return scope.files
    case "path":
      return [resolve(projectDir, scope.path)]
    case "project":
      return scope.workspaceDir !== null
        ? [resolve(projectDir, scope.workspaceDir)]
        : [projectDir]
  }
}

/**
 * The JSON-serializable scope descriptor for `--json` output.
 *
 * @since 0.0.0
 */
const scopeJson = (scope: CheckScope): unknown => {
  switch (scope.kind) {
    case "changed":
      return {
        kind: "changed",
        workspace: scope.workspace,
        files: scope.files,
        error: scope.error
      }
    case "path":
      return { kind: "path", path: scope.path, workspace: scope.workspace }
    case "project":
      return {
        kind: "project",
        workspace: scope.workspace,
        workspaceDir: scope.workspaceDir,
        error: scope.error,
        errorKind: scope.errorKind
      }
  }
}

/**
 * Builds the concise human-readable check report.
 *
 * @since 0.0.0
 */
const buildHuman = (args: {
  review: Review.ReviewResult
  oxlint: { files: number; error: string | null; configSource: string }
  diagnostics: Array<Diagnostic>
  mode: CheckMode
  scope: CheckScope
}): Array<string> => {
  const { review, oxlint, diagnostics, mode, scope } = args
  const changed = scope.kind === "changed"
  const lines: Array<string> = [`effect-lens check (${mode}${changed ? ", changed" : ""})`]
  if (changed) {
    if (scope.error !== null) {
      lines.push(`scope: changed files unavailable (${scope.error})`)
    } else if (scope.files.length === 0) {
      lines.push("scope: no staged files to lint")
    } else {
      lines.push(`scope: ${scope.files.length} changed file(s) to lint`)
    }
    if (scope.workspace !== null) lines.push(`workspace: ${scope.workspace}`)
  } else if (scope.kind === "path") {
    lines.push(`path: ${scope.path}`)
  } else if (scope.kind === "project" && scope.workspace !== null) {
    if (scope.error !== null) {
      lines.push(`workspace: ${scope.workspace} (${scope.errorKind ?? "error"}: ${scope.error})`)
    } else {
      lines.push(`workspace: ${scope.workspace} (scope: ${scope.workspaceDir})`)
    }
  }
  // A changed scope with no matching files and a project scope whose workspace
  // target failed to resolve never spawn oxlint, so there is no lint run to
  // report.
  const oxlintSkipped = (changed && scope.files.length === 0) ||
    (scope.kind === "project" && scope.error !== null)
  if (!oxlintSkipped) {
    if (oxlint.error !== null) {
      lines.push(`oxlint: ${oxlint.error}`)
    } else {
      lines.push(`linted ${oxlint.files} file(s) (config: ${oxlint.configSource})`)
    }
  }
  lines.push(
    `findings: ${review.summary.total} (${review.summary.errors} error(s), ` +
      `${review.summary.warnings} warning(s))`
  )
  if (changed && scope.files.length > 0) {
    lines.push("changed files:")
    for (const file of scope.files) {
      lines.push(`  - ${file}`)
    }
  }
  for (const finding of review.findings) {
    lines.push(
      `  - [${finding.severity}] ${finding.rule} (${
        Option.getOrNull(finding.provider) ?? "lens"
      }) ` +
        `${finding.location.file}:${finding.location.line}`
    )
  }
  if (review.migration.entries.length > 0) {
    lines.push("migration:")
    for (const entry of review.migration.entries) {
      lines.push(
        `  - ${entry.providerRule} → ${entry.canonicalRule} (${entry.count} location(s)): ` +
          entry.recommendation
      )
    }
  }
  const visible = diagnostics.filter((d) => d.severity !== "off")
  if (visible.length > 0) {
    lines.push("diagnostics:")
    for (const d of visible) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
