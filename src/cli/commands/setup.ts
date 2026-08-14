/**
 * `effect-lens setup --dry-run`: build a reviewable, ordered setup plan with
 * no mutations.
 *
 * The command is a thin adapter over the shared-core `buildSetupPlan`
 * operation. It inspects the project's package manager, Effect dependency,
 * reference-pack state, oxlint/Lens configuration, and hook-manager state, and
 * returns an ordered plan. It is strictly read-only: it never writes config,
 * dependencies, packs, or hooks. Actual setup mutation is a deferred follow-up
 * and is rejected by the CLI dispatch until implemented.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as Setup from "../../operations/setup.ts"
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
