/**
 * `effect-lens freshness`: advise on the newest Effect version allowed by the
 * channel and release-age/cooldown policy, and the required reference pack.
 *
 * This is the network-backed, read-only freshness surface (issue #15). It is a
 * thin adapter over the shared-core `buildFreshnessRecommendation` operation:
 * it resolves the project's Effect identity, fetches an explicit registry
 * snapshot, and reports the installed version, declared channel, newest allowed
 * candidate, cooldown/age result, and the candidate's reference-pack status.
 *
 * It is strictly read-only: it never mutates package manifests, lockfiles, or
 * pack caches, and it never selects or fetches a reference pack implicitly. A
 * missing candidate pack is reported as an actionable `catalog-missing` /
 * `not-cached` result. Dependency mutation is left to Nub.
 *
 * The command returns an {@link Effect} (Lens-strict compliant); the CLI
 * entrypoint runs it with `Effect.runPromise`.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import * as Freshness from "../../Freshness.ts"
import { buildFreshnessRecommendation } from "../../operations/freshness.ts"
import * as PackPlan from "../../PackPlan.ts"
import { npmRegistryClient } from "../../RegistryClient.ts"
import type { RegistryClient } from "../../RegistryClient.ts"
import { encode } from "../encode.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only, network-backed `freshness` command as an Effect.
 *
 * @since 0.0.0
 */
export const freshness = (
  context: CliContext & {
    catalogDir?: string
    cooldownDays?: number
    registryUrl?: string
    exclude?: Array<string>
    registry?: RegistryClient
  }
): Effect.Effect<CliResult, never> => {
  const catalog = context.catalogDir === undefined
    ? null
    : PackPlan.loadPackCatalog(context.catalogDir)
  const client = context.registry ?? npmRegistryClient(context.registryUrl)
  return Effect.map(
    buildFreshnessRecommendation({
      projectDir: context.projectDir,
      cacheDir: context.cacheDir,
      workspace: context.workspace,
      registry: client,
      catalog,
      ...(context.cooldownDays === undefined
        ? {}
        : { cooldownPolicy: { minAgeDays: context.cooldownDays } }),
      ...(context.exclude === undefined ? {} : { excludedVersions: context.exclude })
    }),
    (recommendation) => {
      const machineOutput = makeMachineOutput({
        status: aggregateStatus({ findings: [], diagnostics: recommendation.diagnostics }),
        diagnostics: [...recommendation.diagnostics]
      })
      return {
        machineOutput,
        json: {
          machineOutput: encode(MachineOutput, machineOutput),
          recommendation: encode(Freshness.FreshnessRecommendation, recommendation)
        },
        human: buildHuman(recommendation)
      }
    }
  )
}

/**
 * Builds the concise human-readable freshness report.
 *
 * @since 0.0.0
 */
const buildHuman = (recommendation: Freshness.FreshnessRecommendation): Array<string> => {
  const lines: Array<string> = ["effect-lens freshness"]
  const installed = Option.getOrNull(recommendation.installed)
  const declared = Option.getOrNull(recommendation.declaredSpecifier)
  const channel = Option.getOrNull(recommendation.channel)
  const candidate = Option.getOrNull(recommendation.candidate)
  const workspace = Option.getOrNull(recommendation.workspace)
  lines.push(`project: ${recommendation.project}`)
  if (workspace !== null) lines.push(`workspace: ${workspace}`)
  lines.push(`installed: ${installed?.version ?? "none"} (${installed?.source ?? "undeclared"})`)
  lines.push(`declared: ${declared ?? "none"}`)
  lines.push(`channel: ${channel ?? "unknown"}`)
  lines.push(`status: ${recommendation.status}`)
  if (candidate !== null) {
    lines.push(`candidate: ${candidate.version}`)
    const publishedAt = Option.getOrNull(recommendation.candidatePublishedAt)
    if (publishedAt !== null) lines.push(`candidate published: ${publishedAt}`)
    const cooldown = Option.getOrNull(recommendation.cooldown)
    if (cooldown !== null) {
      const age = Option.getOrNull(cooldown.ageDays)
      lines.push(
        `cooldown: ${cooldown.allowed ? "met" : "not met"} (min ${cooldown.minAgeDays} days` +
          (age === null ? ")" : `, age ${age.toFixed(1)} days)`)
      )
    }
    const packStatus = Option.getOrNull(recommendation.packStatus)
    const packId = Option.getOrNull(recommendation.packId)
    lines.push(
      `pack: ${packStatus ?? "unknown"}` + (packId === null ? "" : ` (${packId})`)
    )
  }
  if (recommendation.excluded.length > 0) {
    lines.push(`excluded: ${recommendation.excluded.join(", ")}`)
  }
  if (recommendation.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of recommendation.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  const message = Option.getOrNull(recommendation.message)
  if (message !== null) lines.push(message)
  lines.push("note: advisory only; no files were changed")
  return lines
}
