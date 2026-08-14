/**
 * `effect-lens setup --dry-run` and `effect-lens setup --apply`.
 *
 * `--dry-run` is a thin adapter over the shared-core `buildSetupPlan`
 * operation: it inspects the project's package manager, Effect dependency,
 * reference-pack state, oxlint/Lens configuration, and hook-manager state, and
 * returns an ordered plan. It is strictly read-only.
 *
 * `--apply` is the explicit mutation mode. It is a thin adapter over the
 * shared-core `applySetupPlan` operation, which applies only the actionable,
 * unambiguous hooks step and reports every plan step. It requires `--apply`;
 * plain `setup` never mutates.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as Setup from "../../operations/setup.ts"
import * as SetupApply from "../../operations/setupApply.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only `setup --dry-run` command.
 *
 * @since 0.0.0
 */
export const setup = (context: CliContext): CliResult => {
  const plan = Setup.buildSetupPlan({
    projectDir: context.projectDir,
    cacheDir: context.cacheDir
  })
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: plan.diagnostics }),
    diagnostics: [...plan.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      plan: encode(Setup.SetupPlan, plan)
    },
    human: buildHuman(plan)
  }
}

/**
 * Builds the concise human-readable setup dry-run report.
 *
 * @since 0.0.0
 */
const buildHuman = (plan: Setup.SetupPlan): Array<string> => {
  const lines: Array<string> = ["effect-lens setup --dry-run"]
  const packageManager = Option.getOrNull(plan.packageManager)
  const effect = Option.getOrNull(plan.effect)
  const oxlintPath = Option.getOrNull(plan.oxlint.configPath)
  lines.push(`project: ${plan.project}`)
  lines.push(`package manager: ${packageManager ?? "none detected"}`)
  lines.push(`effect: ${effect?.version ?? "none"} (${effect?.source ?? "undeclared"})`)
  lines.push(`reference pack: ${plan.pack.status}`)
  lines.push(`oxlint: ${oxlintPath ?? "none"} [${plan.oxlint.status}]`)
  lines.push(`hooks: ${plan.hooks.lensStatus}`)
  lines.push("plan:")
  for (const step of plan.steps) {
    const detail = Option.getOrNull(step.detail)
    lines.push(
      `  - [${step.status}] ${step.id}: ${step.title}` +
        (detail === null ? "" : ` — ${detail}`)
    )
  }
  if (plan.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of plan.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  lines.push("note: dry-run only; no files were changed")
  return lines
}

/**
 * Runs the mutating `setup --apply` command.
 *
 * @since 0.0.0
 */
export const setupApply = (context: CliContext): CliResult => {
  const result = SetupApply.applySetupPlan({
    projectDir: context.projectDir,
    cacheDir: context.cacheDir
  })
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: result.diagnostics }),
    diagnostics: [...result.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      apply: encode(SetupApply.SetupApplyResult, result)
    },
    human: buildApplyHuman(result)
  }
}

/**
 * Builds the concise human-readable `setup --apply` report.
 *
 * @since 0.0.0
 */
const buildApplyHuman = (result: SetupApply.SetupApplyResult): Array<string> => {
  const lines: Array<string> = ["effect-lens setup --apply"]
  lines.push(`project: ${result.project}`)
  if (!result.precondition) {
    lines.push("refused: plan is not actionable; no files were changed")
  }
  lines.push("steps:")
  for (const step of result.steps) {
    const detail = Option.getOrNull(step.detail)
    lines.push(
      `  - [${step.outcome}] ${step.id}: ${step.title}` +
        (detail === null ? "" : ` — ${detail}`)
    )
  }
  const mutation = Option.getOrNull(result.hookMutation)
  if (mutation !== null) {
    lines.push(
      `hooks: ${mutation.outcome}` +
        (mutation.changed ? " (changed)" : "") +
        (mutation.created ? " (created)" : "")
    )
  }
  if (result.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of result.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
