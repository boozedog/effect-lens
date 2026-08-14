/**
 * The mutating hook-install/uninstall result model for `hooks install`,
 * `hooks uninstall`, and `setup --apply`.
 *
 * Unlike the read-only status model in `Hooks.ts`, a {@link HookMutationResult}
 * records an explicit install or uninstall attempt against a single hook
 * manager. Lens integrates with existing hook managers by writing a stable
 * Lens-owned marker block rather than overwriting a manager's files, so the
 * result records the target path, whether content changed, whether a file was
 * created, and the outcome. The model is Schema-backed and JSON-serializable so
 * CLI, pi, and future MCP adapters share one contract.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "./Finding.ts"
import { HookManagerName } from "./Hooks.ts"

/**
 * The mutation being attempted.
 *
 * - `install` — add an `effect-lens` check to a hook manager.
 * - `uninstall` — remove a previously installed `effect-lens` check.
 *
 * @since 0.0.0
 */
export const HookOperation = Schema.Literals(["install", "uninstall"])
export type HookOperation = Schema.Schema.Type<typeof HookOperation>

/**
 * The outcome of a single hook mutation attempt.
 *
 * - `applied` — the target was written or removed; the hook state changed.
 * - `noop` — the requested state already held; nothing was written.
 * - `refused` — the mutation was not performed because the target was
 *   ambiguous, unsupported, or absent. Nothing was written.
 *
 * `refused` is intentionally never a partial write: a refused mutation writes
 * nothing at all.
 *
 * @since 0.0.0
 */
export const HookMutationOutcome = Schema.Literals(["applied", "noop", "refused"])
export type HookMutationOutcome = Schema.Schema.Type<typeof HookMutationOutcome>

/**
 * The result of a single hook install or uninstall attempt.
 *
 * `manager` is the hook manager targeted (or `None` when no manager could be
 * resolved). `targetPath` is the project-relative file that would be or was
 * written. `changed` is true when the target file's content changed and
 * `created` is true when the target file did not exist before the mutation.
 * `diagnostics` drive the exit code.
 *
 * @since 0.0.0
 */
export class HookMutationResult extends Schema.Class<HookMutationResult>("HookMutationResult")({
  operation: HookOperation,
  manager: Schema.OptionFromNullOr(HookManagerName),
  targetPath: Schema.OptionFromNullOr(Schema.NonEmptyString),
  outcome: HookMutationOutcome,
  changed: Schema.Boolean,
  created: Schema.Boolean,
  detail: Schema.OptionFromNullOr(Schema.String),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs a {@link HookMutationResult} value.
 *
 * @since 0.0.0
 */
export const makeHookMutationResult = (args: {
  operation: HookOperation
  manager?: HookManagerName | null
  targetPath?: string | null
  outcome: HookMutationOutcome
  changed: boolean
  created?: boolean
  detail?: string | null
  diagnostics?: Array<Diagnostic>
}): HookMutationResult =>
  new HookMutationResult({
    operation: args.operation,
    manager: Option.fromNullishOr(args.manager),
    targetPath: Option.fromNullishOr(args.targetPath),
    outcome: args.outcome,
    changed: args.changed,
    created: args.created ?? false,
    detail: Option.fromNullishOr(args.detail),
    diagnostics: args.diagnostics ?? []
  })

export type { Diagnostic } from "./Finding.ts"
export type { HookManagerName } from "./Hooks.ts"
