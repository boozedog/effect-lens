/**
 * `effect-lens hooks status|install|uninstall`.
 *
 * `status` is a thin adapter over the shared-core `hooksStatus` operation. It
 * is read-only: it never writes hook files or configuration. The aggregate
 * {@link MachineOutput} status is `ok` when lens checks are installed and
 * `warning` when they are absent or ambiguous.
 *
 * `install` and `uninstall` are the explicit mutation surfaces, adapters over
 * the shared-core `applyHookMutation` operation. They write or remove a stable
 * Lens-owned marker block in the target hook manager's file and preserve all
 * other content. They are idempotent and refuse ambiguous or unsupported
 * targets without partial mutation.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as HookMutation from "../../operations/hookMutation.ts"
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

/**
 * Runs the mutating `hooks install` command.
 *
 * @since 0.0.0
 */
export const hooksInstall = (context: CliContext): CliResult => runHookMutation(context, "install")

/**
 * Runs the mutating `hooks uninstall` command.
 *
 * @since 0.0.0
 */
export const hooksUninstall = (context: CliContext): CliResult =>
  runHookMutation(context, "uninstall")

/**
 * Runs a hook install or uninstall mutation and builds the CLI result.
 *
 * @since 0.0.0
 */
const runHookMutation = (
  context: CliContext,
  operation: "install" | "uninstall"
): CliResult => {
  const result = HookMutation.applyHookMutation({
    projectDir: context.projectDir,
    operation,
    workspace: context.workspace,
    command: context.command
  })
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: result.diagnostics }),
    diagnostics: [...result.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      mutation: encode(HookMutation.HookMutationResult, result)
    },
    human: buildMutationHuman(result)
  }
}

/**
 * Builds the concise human-readable install/uninstall report.
 *
 * @since 0.0.0
 */
const buildMutationHuman = (result: HookMutation.HookMutationResult): Array<string> => {
  const lines: Array<string> = [`effect-lens hooks ${result.operation}`]
  const manager = Option.getOrNull(result.manager)
  const target = Option.getOrNull(result.targetPath)
  lines.push(`outcome: ${result.outcome}`)
  lines.push(`manager: ${manager ?? "none"}`)
  lines.push(`target: ${target ?? "none"}`)
  lines.push(`changed: ${result.changed}${result.created ? " (created)" : ""}`)
  const detail = Option.getOrNull(result.detail)
  if (detail !== null) {
    lines.push(`detail: ${detail}`)
  }
  if (result.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of result.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
