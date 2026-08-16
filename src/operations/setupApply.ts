/**
 * Mutating `setup --apply` operation.
 *
 * `setup --apply` turns the read-only {@link SetupPlan} into an explicit,
 * reviewable mutation. It applies only the plan steps that are unambiguous and
 * supported by the current slice (the hooks step), reports every other step as
 * already satisfied, deferred, skipped, or refused, and never mutates when the
 * plan is not actionable.
 *
 * Preconditions (each enforced before any file is written):
 *
 * - No plan step may be `unsupported`; if one is, the apply refuses entirely.
 * - When the hooks step needs action, the hook target must resolve to a single
 *   supported manager; if it does not, the apply refuses entirely.
 *
 * The dependency, reference-pack, and oxlint-config steps are reported as
 * `deferred` when they need action, because this slice does not install
 * dependencies, fetch reference packs, or create oxlint configuration. It
 * never creates blanket waivers, force flags, or hidden policy changes.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import type { Diagnostic } from "../Finding.ts"
import {
  makeSetupApplyResult,
  makeSetupApplyStep,
  SetupApplyResult,
  type SetupApplyStep,
  type SetupApplyStepOutcome
} from "../SetupApply.ts"
import { applyHookMutation } from "./hookMutation.ts"
import { buildSetupPlan } from "./setup.ts"

/**
 * The disposition of every step in a plan that was refused before any mutation
 * because it contained an `unsupported` step.
 *
 * @since 0.0.0
 */
const refusedSteps = (
  plan: ReturnType<typeof buildSetupPlan>
): Array<SetupApplyStep> =>
  plan.steps.map((s) => {
    if (s.status === "unsupported") {
      return makeSetupApplyStep({
        id: s.id,
        title: s.title,
        status: s.status,
        outcome: "refused",
        detail: Option.getOrNull(s.detail) ?? "unsupported by detected tooling"
      })
    }
    if (s.status === "ok") {
      return makeSetupApplyStep({ id: s.id, title: s.title, status: s.status, outcome: "ok" })
    }
    if (s.status === "skip") {
      return makeSetupApplyStep({
        id: s.id,
        title: s.title,
        status: s.status,
        outcome: "skipped"
      })
    }
    return makeSetupApplyStep({
      id: s.id,
      title: s.title,
      status: s.status,
      outcome: "deferred",
      detail: "not applied because the plan is not actionable"
    })
  })

/**
 * Maps a plan that passed its preconditions to per-step dispositions. The
 * hooks step takes `hooksOutcome`; every other `needed` step is deferred.
 *
 * @since 0.0.0
 */
const applySteps = (
  plan: ReturnType<typeof buildSetupPlan>,
  hooksOutcome: SetupApplyStepOutcome
): Array<SetupApplyStep> =>
  plan.steps.map((s) => {
    if (s.status === "ok") {
      return makeSetupApplyStep({ id: s.id, title: s.title, status: s.status, outcome: "ok" })
    }
    if (s.status === "skip") {
      return makeSetupApplyStep({
        id: s.id,
        title: s.title,
        status: s.status,
        outcome: "skipped"
      })
    }
    if (s.id === "hooks") {
      return makeSetupApplyStep({
        id: s.id,
        title: s.title,
        status: s.status,
        outcome: hooksOutcome,
        detail: Option.getOrNull(s.detail) ?? null
      })
    }
    // When the hooks step was refused (the plan is not actionable), sibling
    // steps that need action are also not actionable, so they are refused
    // rather than deferred.
    const outcome = hooksOutcome === "refused" ? "refused" : "deferred"
    return makeSetupApplyStep({
      id: s.id,
      title: s.title,
      status: s.status,
      outcome,
      detail: outcome === "refused"
        ? "not applied because the hooks target could not be resolved"
        : "not applied by this slice"
    })
  })

/**
 * Runs `setup --apply` for a project: applies the actionable hooks step and
 * reports every plan step. Returns {@link SetupApplyResult}.
 *
 * @since 0.0.0
 */
export const applySetupPlan = (args: {
  projectDir: string
  cacheDir: string
  workspace?: string | undefined
  command?: string | undefined
}): SetupApplyResult => {
  const plan = buildSetupPlan(args)
  const hasUnsupported = plan.steps.some((s) => s.status === "unsupported")

  if (hasUnsupported) {
    return makeSetupApplyResult({
      project: args.projectDir,
      precondition: false,
      steps: refusedSteps(plan),
      hookMutation: null,
      diagnostics: [...plan.diagnostics]
    })
  }

  const hooksStep = plan.steps.find((s) => s.id === "hooks")
  if (hooksStep === undefined || hooksStep.status !== "needed") {
    // Nothing to apply: hooks is already satisfied. Other `needed` steps are
    // deferred, so their advisory warnings still drive a warning exit code.
    return makeSetupApplyResult({
      project: args.projectDir,
      precondition: true,
      steps: applySteps(plan, "ok"),
      hookMutation: null,
      diagnostics: [...plan.diagnostics]
    })
  }

  const mutation = applyHookMutation({
    projectDir: args.projectDir,
    operation: "install",
    workspace: args.workspace,
    command: args.command
  })
  const hooksOutcome: SetupApplyStepOutcome = mutation.outcome === "applied"
    ? "applied"
    : mutation.outcome === "noop"
    ? "ok"
    : "refused"
  const diagnostics: Array<Diagnostic> = []
  for (const d of plan.diagnostics) {
    // The hooks step was acted on; its advisory "needed" warning no longer applies.
    if (d.id === "setup-step-needed-hooks") continue
    diagnostics.push(d)
  }
  diagnostics.push(...mutation.diagnostics)
  return makeSetupApplyResult({
    project: args.projectDir,
    precondition: mutation.outcome !== "refused",
    steps: applySteps(plan, hooksOutcome),
    hookMutation: mutation,
    diagnostics
  })
}

export type { Diagnostic } from "../Finding.ts"
export type { HookMutationResult } from "../HookMutation.ts"
export { SetupApplyResult }
export type { SetupApplyStep, SetupApplyStepOutcome } from "../SetupApply.ts"
