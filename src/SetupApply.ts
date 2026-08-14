/**
 * The result model for the mutating `setup --apply` surface.
 *
 * `setup --apply` turns a read-only {@link SetupPlan} into an explicit,
 * reviewable mutation. It applies only the plan steps that are unambiguous and
 * supported by the current slice (the hooks step), reports every other step as
 * already satisfied, deferred, skipped, or refused, and never mutates when the
 * plan is not actionable. The model is Schema-backed and JSON-serializable so
 * CLI, pi, and future MCP adapters share one contract.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "./Finding.ts"
import { HookMutationResult } from "./HookMutation.ts"
import { SetupStepStatus } from "./Setup.ts"

/**
 * The disposition of a single setup-plan step after an apply attempt.
 *
 * - `applied` — the step's action was performed.
 * - `ok` — the step was already satisfied; no action was needed.
 * - `deferred` — the step needs action but is not implemented by this slice;
 *   it was left untouched.
 * - `refused` — the step is unsupported or the apply precondition failed;
 *   nothing was written.
 * - `skipped` — the step is not applicable to this project.
 *
 * @since 0.0.0
 */
export const SetupApplyStepOutcome = Schema.Literals([
  "applied",
  "ok",
  "deferred",
  "refused",
  "skipped"
])
export type SetupApplyStepOutcome = Schema.Schema.Type<typeof SetupApplyStepOutcome>

/**
 * A single setup-plan step and its disposition after an apply attempt.
 *
 * `status` is the step's read-only dry-run status; `outcome` is what the apply
 * attempt did with it.
 *
 * @since 0.0.0
 */
export class SetupApplyStep extends Schema.Class<SetupApplyStep>("SetupApplyStep")({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  status: SetupStepStatus,
  outcome: SetupApplyStepOutcome,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The complete result of a `setup --apply` attempt.
 *
 * `precondition` is false when the apply refused before performing any
 * mutation because the plan was not actionable (an unsupported step or an
 * uninstallable hooks target). `hookMutation` carries the result of the hooks
 * step when it was attempted. `diagnostics` drive the exit code.
 *
 * @since 0.0.0
 */
export class SetupApplyResult extends Schema.Class<SetupApplyResult>("SetupApplyResult")({
  project: Schema.NonEmptyString,
  precondition: Schema.Boolean,
  steps: Schema.Array(SetupApplyStep),
  hookMutation: Schema.OptionFromNullOr(HookMutationResult),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs a {@link SetupApplyStep} value.
 *
 * @since 0.0.0
 */
export const makeSetupApplyStep = (args: {
  id: string
  title: string
  status: Schema.Schema.Type<typeof SetupStepStatus>
  outcome: SetupApplyStepOutcome
  detail?: string | null
}): SetupApplyStep =>
  new SetupApplyStep({
    id: args.id,
    title: args.title,
    status: args.status,
    outcome: args.outcome,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * Constructs a {@link SetupApplyResult} value.
 *
 * @since 0.0.0
 */
export const makeSetupApplyResult = (args: {
  project: string
  precondition: boolean
  steps: Array<SetupApplyStep>
  hookMutation?: HookMutationResult | null
  diagnostics?: Array<Diagnostic>
}): SetupApplyResult =>
  new SetupApplyResult({
    project: args.project,
    precondition: args.precondition,
    steps: args.steps,
    hookMutation: Option.fromNullishOr(args.hookMutation),
    diagnostics: args.diagnostics ?? []
  })

export type { Diagnostic } from "./Finding.ts"
export type { HookMutationResult } from "./HookMutation.ts"
export type { SetupStepStatus } from "./Setup.ts"
