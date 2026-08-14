/**
 * `effect-lens check`: run the available local read-only review path and
 * aggregate findings and diagnostics into a {@link MachineOutput}.
 *
 * Check runs oxlint (with the Lens plugin loaded) over the target path, feeds
 * the JSON diagnostics into the shared-core `review` operation, and aggregates
 * the resulting findings and diagnostics. It is read-only: it never mutates
 * source, caches, or configuration. If oxlint is unavailable, a diagnostic is
 * emitted instead of crashing.
 *
 * @since 0.0.0
 */
import { resolve } from "node:path"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import type { Diagnostic } from "../../Finding.ts"
import * as Review from "../../operations/review.ts"
import { makeDiagnostic } from "../../operations/shared.ts"
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
}): CliResult => {
  const target = args.path === undefined
    ? args.projectDir
    : resolve(args.projectDir, args.path)
  const oxlint = runOxlint({ projectDir: args.projectDir, target })
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
  const review = Review.review({
    input: Review.makeReviewInput({ diagnostics: oxlint.diagnostics })
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
      oxlint: { files: oxlint.files, error: oxlint.error }
    },
    human: buildHuman({ review, oxlint, diagnostics })
  }
}

/**
 * Builds the concise human-readable check report.
 *
 * @since 0.0.0
 */
const buildHuman = (args: {
  review: Review.ReviewResult
  oxlint: { files: number; error: string | null }
  diagnostics: Array<Diagnostic>
}): Array<string> => {
  const { review, oxlint, diagnostics } = args
  const lines: Array<string> = ["effect-lens check"]
  if (oxlint.error !== null) {
    lines.push(`oxlint: ${oxlint.error}`)
  } else {
    lines.push(`linted ${oxlint.files} file(s)`)
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
  if (diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
