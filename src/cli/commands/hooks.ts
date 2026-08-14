/**
 * `effect-lens hooks status`: report the state of known hook managers and
 * whether an `effect-lens` check is installed.
 *
 * The command is a thin adapter over the shared-core `hooksStatus` operation.
 * It is read-only: it never writes hook files or configuration. The aggregate
 * {@link MachineOutput} status is `ok` when lens checks are installed and
 * `warning` when they are absent or ambiguous.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as Hooks from "../../operations/hooks.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only `hooks status` command.
 *
 * @since 0.0.0
 */
export const hooks = (context: CliContext): CliResult => {
  const status = Hooks.hooksStatus(context.projectDir)
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: status.diagnostics }),
    diagnostics: [...status.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      hooks: encode(Hooks.HooksStatus, status)
    },
    human: buildHuman(status)
  }
}

/**
 * Builds the concise human-readable hooks status report.
 *
 * @since 0.0.0
 */
const buildHuman = (status: Hooks.HooksStatus): Array<string> => {
  const lines: Array<string> = ["effect-lens hooks status"]
  lines.push(`lens checks: ${status.lensStatus}`)
  lines.push("managers:")
  for (const m of status.managers) {
    const configPath = Option.getOrNull(m.configPath)
    const detail = Option.getOrNull(m.detail)
    lines.push(
      `  - ${m.manager}: ${m.present ? "present" : "not present"} [${m.lensStatus}]` +
        (configPath === null ? "" : ` (${configPath})`) +
        (detail === null ? "" : ` — ${detail}`)
    )
  }
  if (status.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of status.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
