/**
 * `effect-lens check`: run the available local read-only review path and
 * aggregate findings and diagnostics into a {@link MachineOutput}.
 *
 * Check runs oxlint (with the Lens plugin loaded) over the target path, feeds
 * the JSON diagnostics into the shared-core `review` operation, and aggregates
 * the resulting findings and diagnostics. In `lens-only` mode (the default) a
 * fresh scratch config is used; in `unified` mode the target repository's
 * oxlint config is preserved while the Lens rules are loaded. It is read-only:
 * it never mutates source, caches, or the project's own configuration (in
 * `unified` mode it writes a transient sidecar config that is removed in a
 * `finally` block). If oxlint is unavailable, a diagnostic is emitted instead
 * of crashing.
 *
 * @since 0.0.0
 */
import { resolve } from "node:path"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import type { Diagnostic } from "../../Finding.ts"
import * as Review from "../../operations/review.ts"
import { makeDiagnostic } from "../../operations/shared.ts"
import { type CheckMode, DEFAULT_CHECK_MODE } from "../../provider/Provider.ts"
import { encode } from "../encode.ts"
import { runOxlint } from "../oxlint.ts"
import type { CliResult } from "../types.ts"

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
}): CliResult => {
  const mode = args.mode ?? DEFAULT_CHECK_MODE
  const target = args.path === undefined
    ? args.projectDir
    : resolve(args.projectDir, args.path)
  const oxlint = runOxlint({ projectDir: args.projectDir, target, mode })
  const diagnostics: Array<Diagnostic> = []
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
      oxlint: {
        files: oxlint.files,
        error: oxlint.error,
        mode,
        config: oxlint.configSource,
        configWarning: oxlint.configWarning
      }
    },
    human: buildHuman({ review, oxlint, diagnostics: allDiagnostics, mode })
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
}): Array<string> => {
  const { review, oxlint, diagnostics, mode } = args
  const lines: Array<string> = [`effect-lens check (${mode})`]
  if (oxlint.error !== null) {
    lines.push(`oxlint: ${oxlint.error}`)
  } else {
    lines.push(`linted ${oxlint.files} file(s) (config: ${oxlint.configSource})`)
  }
  lines.push(
    `findings: ${review.summary.total} (${review.summary.errors} error(s), ` +
      `${review.summary.warnings} warning(s))`
  )
  for (const finding of review.findings) {
    lines.push(
      `  - [${finding.severity}] ${finding.rule} ${finding.location.file}:${finding.location.line}`
    )
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
