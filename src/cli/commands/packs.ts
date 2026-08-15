/**
 * `effect-lens packs plan` and `effect-lens packs fetch`.
 *
 * `packs plan` is a thin adapter over the shared-core read-only planner
 * (`PackPlan.planPackAcquisition`): it loads an explicit catalog baseline and
 * returns an ordered, JSON-serializable acquisition plan. It is strictly
 * read-only — it never fetches, writes, deletes, or updates cache files.
 *
 * `packs fetch` is the explicit mutation surface for reference-pack
 * acquisition. It requires an explicit `--catalog` directory and an exact
 * `--id` selection, loads the matching catalog entry, and invokes the shared
 * acquisition executor (`PackAcquire.acquirePack`) with the local-directory
 * transport (`PackTransport.stageLocalDirectory`). It never fetches
 * implicitly: no other command, plan, doctor, drift, lookup, or guidance
 * path invokes a transport. An existing complete pack is a safe no-op unless
 * `--replace` is passed.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { rmSync } from "node:fs"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import { makeDiagnostic } from "../../operations/shared.ts"
import * as PackAcquire from "../../PackAcquire.ts"
import * as PackPlan from "../../PackPlan.ts"
import * as PackTransport from "../../PackTransport.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only `packs plan` command.
 *
 * @since 0.0.0
 */
export const packsPlan = (context: CliContext & { catalogDir: string }): CliResult => {
  const catalog = PackPlan.loadPackCatalog(context.catalogDir)
  const plan = PackPlan.planPackAcquisition({
    projectDir: context.projectDir,
    cacheDir: context.cacheDir,
    catalog
  })
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: plan.diagnostics }),
    diagnostics: [...plan.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      plan: encode(PackPlan.PackAcquisitionPlan, plan)
    },
    human: buildPlanHuman(plan)
  }
}

/**
 * Runs the explicit mutating `packs fetch` command.
 *
 * Loads the catalog baseline, selects the exact entry by `--id`, and invokes
 * the acquisition executor with the local-directory transport. The staged
 * artifact directory is tracked and removed after the executor returns, so a
 * fetch never leaks a temp directory.
 *
 * @since 0.0.0
 */
export const packsFetch = (
  context: CliContext & {
    catalogDir: string
    packId: string
    replace?: boolean
  }
): CliResult => {
  const catalog = PackPlan.loadPackCatalog(context.catalogDir)
  const entry = catalog.entries.find((e) => e.id === context.packId)
  if (entry === undefined) {
    const message = `no catalog entry with id ${context.packId} in ${context.catalogDir}`
    const machineOutput = makeMachineOutput({
      status: 2,
      diagnostics: [makeDiagnostic({ id: "packs-entry-missing", severity: "error", message })]
    })
    return {
      machineOutput,
      json: {
        machineOutput: encode(MachineOutput, machineOutput),
        acquire: null
      },
      human: ["effect-lens packs fetch", `error: ${message}`]
    }
  }
  let stagedDir: string | null = null
  const transport: PackAcquire.PackArtifactTransport = (catalogEntry) => {
    const staged = PackTransport.stageLocalDirectory(catalogEntry)
    if (staged.ok) stagedDir = staged.stagedDir
    return staged
  }
  let result: PackAcquire.AcquirePackResult
  try {
    result = PackAcquire.acquirePack({
      cacheDir: context.cacheDir,
      catalogEntry: entry,
      transport,
      replace: context.replace ?? false
    })
  } finally {
    if (stagedDir !== null) {
      try {
        rmSync(stagedDir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({ findings: [], diagnostics: result.diagnostics }),
    diagnostics: [...result.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      acquire: encode(PackAcquire.AcquirePackResult, result)
    },
    human: buildFetchHuman(result)
  }
}

/**
 * Builds the concise human-readable `packs plan` report.
 *
 * @since 0.0.0
 */
const buildPlanHuman = (plan: PackPlan.PackAcquisitionPlan): Array<string> => {
  const lines: Array<string> = ["effect-lens packs plan"]
  const expected = Option.getOrNull(plan.expected)
  lines.push(`project: ${plan.project}`)
  lines.push(`effect: ${expected?.version ?? "none"} (${expected?.source ?? "undeclared"})`)
  lines.push(`action: ${plan.action}`)
  lines.push("steps:")
  for (const step of plan.steps) {
    const detail = Option.getOrNull(step.detail)
    lines.push(
      `  - [${step.action}] ${step.id}: ${step.title}` +
        (detail === null ? "" : ` — ${detail}`)
    )
  }
  if (plan.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of plan.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  lines.push("note: plan only; no files were changed")
  return lines
}

/**
 * Builds the concise human-readable `packs fetch` report.
 *
 * @since 0.0.0
 */
const buildFetchHuman = (result: PackAcquire.AcquirePackResult): Array<string> => {
  const lines: Array<string> = ["effect-lens packs fetch"]
  lines.push(
    `entry: ${result.entry.id} (${result.entry.packageIdentity.name}@${result.entry.packageIdentity.version})`
  )
  lines.push(`action: ${result.action}`)
  lines.push(`cache: ${result.cacheDir}`)
  if (result.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of result.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  return lines
}
