/**
 * `effect-lens adoption audit`: build a read-only staged-adoption audit
 * report for a selected project/workspace.
 *
 * The audit is the first phase of the staged Foldstryx adoption path (issue
 * #14). It is a thin adapter over the shared-core `buildAdoptionAudit`
 * operation: it runs oxlint in unified mode over the project (reusing the
 * `check` oxlint runner) and passes the resulting diagnostics into the
 * operation, which reports the target identity, resolved Effect version,
 * reference-pack status, detected oxlint config and scopes, active
 * Lens/Foldstryx/StyleX providers and rules, equivalent-rule overlaps, current
 * unified-gate findings, and actionable migration recommendations.
 *
 * It is strictly read-only and offline: it never mutates source, configs,
 * packs, dependencies, or hooks, never removes Foldstryx rules, never creates
 * waivers, and never fetches packs or the network. The unified-mode oxlint
 * run writes a transient config that is removed in a `finally` block, exactly
 * like `check`. If oxlint is unavailable, a warning diagnostic is emitted
 * instead of crashing.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import type { MigrationEntry } from "../../Adoption.ts"
import { aggregateStatus, MachineOutput, makeMachineOutput } from "../../ExitStatus.ts"
import type { Finding } from "../../Finding.ts"
import * as Adoption from "../../operations/adoption.ts"
import { encode } from "../encode.ts"
import { runOxlint } from "../oxlint.ts"
import type { CliContext, CliResult } from "../types.ts"

/**
 * Runs the read-only `adoption audit` command.
 *
 * @since 0.0.0
 */
export const adoptionAudit = (context: CliContext): CliResult => {
  const oxlint = runOxlint({
    projectDir: context.projectDir,
    target: context.projectDir,
    mode: "unified"
  })
  const audit = Adoption.buildAdoptionAudit({
    projectDir: context.projectDir,
    cacheDir: context.cacheDir,
    workspace: context.workspace,
    gate: { diagnostics: oxlint.diagnostics, error: oxlint.error }
  })
  const machineOutput = makeMachineOutput({
    status: aggregateStatus({
      findings: audit.gate.findings,
      diagnostics: [...audit.diagnostics, ...audit.gate.diagnostics]
    }),
    findings: [...audit.gate.findings],
    diagnostics: [...audit.diagnostics, ...audit.gate.diagnostics]
  })
  return {
    machineOutput,
    json: {
      machineOutput: encode(MachineOutput, machineOutput),
      audit: encode(Adoption.AdoptionAudit, audit)
    },
    human: buildHuman(audit)
  }
}

/**
 * Builds the concise human-readable adoption audit report.
 *
 * @since 0.0.0
 */
const buildHuman = (audit: Adoption.AdoptionAudit): Array<string> => {
  const lines: Array<string> = ["effect-lens adoption audit"]
  const workspace = Option.getOrNull(audit.workspace)
  const expected = Option.getOrNull(audit.resolution.expected)
  const oxlintPath = Option.getOrNull(audit.oxlint.configPath)
  lines.push(`project: ${audit.project}`)
  if (workspace !== null) lines.push(`workspace: ${workspace}`)
  lines.push(`effect: ${expected?.version ?? "none"} (${expected?.source ?? "undeclared"})`)
  lines.push(`reference pack: ${audit.pack.status}`)
  lines.push(`oxlint: ${oxlintPath ?? "none"} [${audit.oxlint.status}]`)
  const scopes = audit.oxlintScopes
  if (scopes.ignorePatterns.length > 0) {
    lines.push(`ignore patterns: ${scopes.ignorePatterns.join(", ")}`)
  }
  if (scopes.overrides.length > 0) {
    lines.push(`overrides: ${scopes.overrides.length} block(s)`)
  }
  lines.push("providers:")
  for (const provider of audit.providers) {
    lines.push(
      `  - ${provider.provider} [${provider.active ? "active" : "inactive"}]` +
        (provider.rules.length > 0 ? `: ${provider.rules.join(", ")}` : "")
    )
  }
  if (audit.overlaps.length > 0) {
    lines.push("equivalent-rule overlaps:")
    for (const overlap of audit.overlaps) {
      lines.push(`  - ${overlap.providerRule} → ${overlap.canonicalRule}`)
    }
  }
  const gateError = Option.getOrNull(audit.gate.error)
  if (gateError !== null) {
    lines.push(`unified gate: unavailable (${gateError})`)
  } else {
    lines.push(
      `unified gate: ${audit.gate.summary.total} finding(s) ` +
        `(${audit.gate.summary.errors} error(s), ${audit.gate.summary.warnings} warning(s))`
    )
    for (const finding of audit.gate.findings as ReadonlyArray<Finding>) {
      lines.push(
        `  - [${finding.severity}] ${finding.rule} ${finding.location.file}:${finding.location.line}`
      )
    }
    if (audit.gate.migration.length > 0) {
      lines.push("migration:")
      for (const entry of audit.gate.migration as ReadonlyArray<MigrationEntry>) {
        lines.push(
          `  - ${entry.providerRule} → ${entry.canonicalRule} (${entry.count} location(s))`
        )
      }
    }
  }
  if (audit.recommendations.length > 0) {
    lines.push("recommendations:")
    for (const recommendation of audit.recommendations) {
      const detail = Option.getOrNull(recommendation.detail)
      lines.push(
        `  - [${recommendation.kind}] ${recommendation.message}` +
          (detail === null ? "" : ` (${detail})`)
      )
    }
  }
  if (audit.diagnostics.length > 0) {
    lines.push("diagnostics:")
    for (const d of audit.diagnostics) {
      lines.push(`  - [${d.severity}] ${d.message}`)
    }
  }
  lines.push("note: audit only; no files were changed")
  return lines
}
