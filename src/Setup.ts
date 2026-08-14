/**
 * The read-only setup plan model for the `setup --dry-run` surface.
 *
 * A dry-run plan inspects the project's package manager, Effect dependency,
 * reference-pack state, oxlint/Lens configuration, and hook-manager state, then
 * returns an ordered list of steps with no mutations. Each step is `ok`
 * (already satisfied), `needed` (an action would be required), `unsupported`
 * (cannot be completed with the detected tooling), or `skip` (not applicable).
 * The model is Schema-backed and JSON-serializable so CLI, pi, and future MCP
 * adapters share one contract.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "./Finding.ts"
import { HooksStatus } from "./Hooks.ts"
import { PackageIdentity } from "./PackageIdentity.ts"
import { PackVerificationResult } from "./PackVerifier.ts"
import { Resolution } from "./Resolver.ts"

/**
 * The state of a single setup step in a dry-run plan.
 *
 * - `ok` — already satisfied; no action needed.
 * - `needed` — an action would be required to complete setup.
 * - `unsupported` — cannot be completed with the detected tooling.
 * - `skip` — not applicable to this project.
 *
 * @since 0.0.0
 */
export const SetupStepStatus = Schema.Literals(["ok", "needed", "unsupported", "skip"])
export type SetupStepStatus = Schema.Schema.Type<typeof SetupStepStatus>

/**
 * A single ordered step in a dry-run setup plan.
 *
 * @since 0.0.0
 */
export class SetupStep extends Schema.Class<SetupStep>("SetupStep")({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  status: SetupStepStatus,
  detail: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The state of the project's oxlint / Lens configuration.
 *
 * - `configured` — a parseable oxlint config references the Lens plugin or
 *   `lens/` rules.
 * - `missing` — no oxlint config, or a parseable config without Lens.
 * - `ambiguous` — an oxlint config is present but cannot be read or parsed.
 *
 * @since 0.0.0
 */
export const OxlintStatusKind = Schema.Literals(["configured", "missing", "ambiguous"])
export type OxlintStatusKind = Schema.Schema.Type<typeof OxlintStatusKind>

/**
 * The oxlint / Lens configuration status for a project.
 *
 * @since 0.0.0
 */
export class OxlintStatus extends Schema.Class<OxlintStatus>("OxlintStatus")({
  configPath: Schema.OptionFromNullOr(Schema.NonEmptyString),
  lensPluginConfigured: Schema.Boolean,
  status: OxlintStatusKind
}) {}

/**
 * A complete read-only setup plan for a project.
 *
 * `project` is the absolute project directory. `packageManager` is the detected
 * manager (from lockfile or the `packageManager` field) or `null`. `effect` is
 * the resolved expected Effect identity or `null`. `resolution`, `pack`,
 * `oxlint`, and `hooks` carry the underlying inspection results, and `steps`
 * is the ordered plan. `diagnostics` drive the exit code.
 *
 * @since 0.0.0
 */
export class SetupPlan extends Schema.Class<SetupPlan>("SetupPlan")({
  project: Schema.NonEmptyString,
  packageManager: Schema.OptionFromNullOr(Schema.NonEmptyString),
  effect: Schema.OptionFromNullOr(PackageIdentity),
  resolution: Resolution,
  pack: PackVerificationResult,
  oxlint: OxlintStatus,
  hooks: HooksStatus,
  steps: Schema.Array(SetupStep),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs a {@link SetupStep} value.
 *
 * @since 0.0.0
 */
export const makeSetupStep = (args: {
  id: string
  title: string
  status: SetupStepStatus
  detail?: string | null
}): SetupStep =>
  new SetupStep({
    id: args.id,
    title: args.title,
    status: args.status,
    detail: Option.fromNullishOr(args.detail)
  })

/**
 * Constructs an {@link OxlintStatus} value.
 *
 * @since 0.0.0
 */
export const makeOxlintStatus = (args: {
  configPath?: string | null
  lensPluginConfigured: boolean
  status: OxlintStatusKind
}): OxlintStatus =>
  new OxlintStatus({
    configPath: Option.fromNullishOr(args.configPath),
    lensPluginConfigured: args.lensPluginConfigured,
    status: args.status
  })

/**
 * Constructs a {@link SetupPlan} value.
 *
 * @since 0.0.0
 */
export const makeSetupPlan = (args: {
  project: string
  packageManager?: string | null
  effect?: PackageIdentity | null
  resolution: Resolution
  pack: PackVerificationResult
  oxlint: OxlintStatus
  hooks: HooksStatus
  steps: Array<SetupStep>
  diagnostics?: Array<Diagnostic>
}): SetupPlan =>
  new SetupPlan({
    project: args.project,
    packageManager: Option.fromNullishOr(args.packageManager),
    effect: Option.fromNullishOr(args.effect),
    resolution: args.resolution,
    pack: args.pack,
    oxlint: args.oxlint,
    hooks: args.hooks,
    steps: args.steps,
    diagnostics: args.diagnostics ?? []
  })

export type { Diagnostic } from "./Finding.ts"
export type { HooksStatus } from "./Hooks.ts"
export type { PackageIdentity } from "./PackageIdentity.ts"
export type { PackVerificationResult } from "./PackVerifier.ts"
export type { Resolution } from "./Resolver.ts"
