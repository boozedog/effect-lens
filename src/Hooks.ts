/**
 * Hook-manager status model for the read-only `hooks status` surface.
 *
 * Lens integrates with existing hook managers rather than overwriting them, so
 * the status model records, per known manager, whether the manager is present
 * and whether an `effect-lens` check is installed, absent, or ambiguous. The
 * model is Schema-backed and JSON-serializable so CLI, pi, and future MCP
 * adapters share one contract. Detection is read-only: it never writes hook
 * files or configuration.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "./Finding.ts"

/**
 * The hook managers Lens knows how to inspect. Each is detected by a known
 * file or `package.json` field; a manager not present is reported as absent
 * rather than omitted, so the output is complete and deterministic.
 *
 * @since 0.0.0
 */
export const HookManagerName = Schema.Literals([
  "husky",
  "lefthook",
  "pre-commit",
  "lint-staged",
  "simple-git-hooks"
])
export type HookManagerName = Schema.Schema.Type<typeof HookManagerName>

/**
 * Whether an `effect-lens` check is installed for a hook manager.
 *
 * - `installed` — the manager is present and its config references `effect-lens`.
 * - `absent` — the manager is present (or not) and no `effect-lens` reference
 *   was found in a readable config.
 * - `ambiguous` — the manager is present but its config cannot be read, so the
 *   installed state cannot be determined.
 *
 * @since 0.0.0
 */
export const LensInstallStatus = Schema.Literals(["installed", "absent", "ambiguous"])
export type LensInstallStatus = Schema.Schema.Type<typeof LensInstallStatus>

/**
 * The status of a single known hook manager.
 *
 * @since 0.0.0
 */
export class HookManagerStatus extends Schema.Class<HookManagerStatus>("HookManagerStatus")({
  manager: HookManagerName,
  present: Schema.Boolean,
  configPath: Schema.OptionFromNullOr(Schema.NonEmptyString),
  lensStatus: LensInstallStatus,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The aggregate hook-manager status for a project.
 *
 * `lensStatus` is `installed` when any manager has an `effect-lens` check,
 * `ambiguous` when any manager is ambiguous and none is installed, and
 * `absent` otherwise.
 *
 * @since 0.0.0
 */
export class HooksStatus extends Schema.Class<HooksStatus>("HooksStatus")({
  lensStatus: LensInstallStatus,
  managers: Schema.Array(HookManagerStatus),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs a {@link HookManagerStatus} value.
 *
 * @since 0.0.0
 */
export const makeHookManagerStatus = (args: {
  manager: HookManagerName
  present: boolean
  configPath?: string | null
  lensStatus: LensInstallStatus
  detail?: string | null
}): HookManagerStatus =>
  new HookManagerStatus({
    manager: args.manager,
    present: args.present,
    configPath: Option.fromNullishOr(args.configPath),
    lensStatus: args.lensStatus,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * Constructs a {@link HooksStatus} value.
 *
 * @since 0.0.0
 */
export const makeHooksStatus = (args: {
  lensStatus: LensInstallStatus
  managers: Array<HookManagerStatus>
  diagnostics?: Array<Diagnostic>
}): HooksStatus =>
  new HooksStatus({
    lensStatus: args.lensStatus,
    managers: args.managers,
    diagnostics: args.diagnostics ?? []
  })

export type { Diagnostic } from "./Finding.ts"
