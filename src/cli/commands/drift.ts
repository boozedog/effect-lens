/**
 * `effect-lens drift`: emit a stable local drift report over the project's
 * Effect dependency and reference pack.
 *
 * The report is built by the shared-core `drift` operation and serialized with
 * the existing {@link DriftReport} contracts. Full comparison against live
 * upstream tooling is not available in this offline slice; that limitation is
 * surfaced explicitly as a diagnostic rather than inventing compatibility.
 * Read-only: never fetches packs or mutates caches or configuration.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Drift from "../../Drift.ts"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import type { Diagnostic } from "../../Finding.ts"
import { buildDriftReport } from "../../operations/drift.ts"
import { makeDiagnostic } from "../../operations/shared.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"
import { VERSION } from "../version.ts"

/**
 * The diagnostic that makes the offline scope of this slice explicit.
 *
 * @since 0.0.0
 */
const OFFLINE_LIMITATION: Diagnostic = makeDiagnostic({
  id: "drift-upstream-unavailable",
  severity: "off",
  message:
    "full upstream comparison is not available in this offline slice; the report reflects local dependency and reference-pack state only"
})

/**
 * Builds a warning diagnostic for each non-compatible drift entry, so the exit
 * code reflects the presence of drift.
 *
 * @since 0.0.0
 */
const entryDiagnostics = (report: Drift.DriftReport): Array<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = []
  for (const entry of report.entries) {
    if (entry.kind === "compatible") continue
    const detail = Option.getOrNull(entry.detail)
    diagnostics.push(
      makeDiagnostic({
        id: `drift-${entry.kind}-${entry.packageIdentity.name}-${entry.role}`,
        severity: "warning",
        message: detail ?? `${entry.packageIdentity.name} drift: ${entry.kind}`
      })
    )
  }
  return diagnostics
}

/**
 * Runs the read-only `drift` command.
 *
 * @since 0.0.0
 */
export const drift = (context: CliContext): CliResult => {
  const report = buildDriftReport({
    projectDir: context.projectDir,
    cacheDir: context.cacheDir,
    lensVersion: VERSION
  })
  const diagnostics = [...entryDiagnostics(report), OFFLINE_LIMITATION]
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics }),
    diagnostics
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      report: encode(Drift.DriftReport, report)
    },
    human: buildHuman(report)
  }
}

/**
 * Builds the concise human-readable drift report.
 *
 * @since 0.0.0
 */
const buildHuman = (report: Drift.DriftReport): Array<string> => {
  const lines: Array<string> = ["effect-lens drift"]
  const toolchain = report.toolchain
  const effect = toolchain.effect
  const packageManager = Option.getOrNull(toolchain.packageManager)
  const node = Option.getOrNull(toolchain.node)
  lines.push(
    `toolchain: lens ${toolchain.lensVersion}, effect ${effect.version} (${effect.source}), ` +
      `${packageManager ?? "no package manager"}, node ${node ?? "unknown"}`
  )
  if (report.entries.length === 0) {
    lines.push("entries: none")
  } else {
    lines.push("entries:")
    for (const entry of report.entries) {
      const detail = Option.getOrNull(entry.detail)
      lines.push(
        `  - ${entry.packageIdentity.name}@${entry.packageIdentity.version}: ${entry.kind}` +
          (detail === null ? "" : ` (${detail})`)
      )
    }
  }
  lines.push("note: full upstream comparison is not available in this offline slice")
  return lines
}
