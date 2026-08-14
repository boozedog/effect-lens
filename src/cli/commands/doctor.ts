/**
 * `effect-lens doctor`: report Effect resolution, installed mismatch,
 * reference-pack status, and actionable diagnostics.
 *
 * The command is a thin adapter: it delegates the resolution, pack
 * verification, and diagnostic policy to the shared-core `doctor` operation,
 * then aggregates the result into a {@link MachineOutput} whose status drives
 * the exit code. Read-only: it never fetches packs or mutates caches or
 * configuration.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as Doctor from "../../operations/doctor.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only `doctor` command.
 *
 * @since 0.0.0
 */
export const doctor = (context: CliContext): CliResult => {
  const { resolution, pack, diagnostics } = Doctor.doctorDiagnostics(context)
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics }),
    diagnostics
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      resolution: encode(Doctor.Resolver.Resolution, resolution),
      pack: encode(Doctor.PackVerifier.PackVerificationResult, pack)
    },
    human: buildHuman({ resolution, pack, diagnostics })
  }
}

/**
 * Builds the concise human-readable doctor report.
 *
 * @since 0.0.0
 */
const buildHuman = (args: {
  resolution: Doctor.Resolver.Resolution
  pack: Doctor.PackVerifier.PackVerificationResult
  diagnostics: Array<Doctor.Diagnostic>
}): Array<string> => {
  const { resolution, pack, diagnostics } = args
  const lines: Array<string> = ["effect-lens doctor"]
  const expected = Option.getOrNull(resolution.expected)
  const installed = Option.getOrNull(resolution.installed)
  lines.push(
    `effect: ${expected?.version ?? "none"} (${
      expected?.source ?? "undeclared"
    }) [${resolution.status}]`
  )
  lines.push(`installed: ${installed?.version ?? "not installed"}`)
  const packId = Option.getOrNull(pack.pack)?.id ?? "none"
  lines.push(`reference pack: ${packId} [${pack.status}]`)
  if (diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
