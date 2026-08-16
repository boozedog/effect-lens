/**
 * Read-only `adoption audit` operation: build a staged-adoption audit report
 * for a selected project/workspace.
 *
 * The audit is the first phase of the staged Foldstryx adoption path (issue
 * #14). It inspects the project's Effect resolution, reference-pack state,
 * oxlint configuration and scopes, active Lens/Foldstryx/StyleX providers and
 * rules, equivalent-rule overlaps, and the current unified-gate findings, and
 * returns actionable migration recommendations. It is strictly read-only and
 * offline: it never mutates source, configs, packs, dependencies, or hooks,
 * never removes Foldstryx rules, never creates waivers, and never fetches
 * packs or the network. Freshness lookup is a separate network-backed surface
 * (`freshness`); the audit itself stays offline.
 *
 * The operation reuses the existing provider/equivalence and pack-status
 * contracts rather than duplicating policy: Effect resolution via
 * {@link Resolver.resolveEffectIdentity}, reference-pack verification via
 * {@link PackVerifier.verifyReferencePack}, oxlint/Lens status via
 * {@link Setup.oxlintStatus}, rule equivalence via
 * {@link foldstryxEquivalences}, and unified-gate findings via
 * {@link Review.review}. The unified-gate oxlint diagnostics are supplied by
 * the adapter (the CLI runs oxlint in unified mode); the operation itself
 * never invokes a toolchain.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  AdoptionAudit,
  makeAdoptionAudit,
  makeGateFindings,
  makeGateSummary,
  makeMigrationEntry,
  makeOxlintScopes,
  makeProviderStatus,
  makeRecommendation,
  makeRuleOverlap,
  type OxlintScopes,
  type RecommendationKind
} from "../Adoption.ts"
import * as PackVerifier from "../PackVerifier.ts"
import { foldstryxEquivalences } from "../provider/equivalence.ts"
import { foldstryxProvider } from "../provider/foldstryx.ts"
import { lensProvider } from "../provider/lens.ts"
import { stylexProvider } from "../provider/stylex.ts"
import * as Resolver from "../Resolver.ts"
import { rules } from "../rules/index.ts"
import * as Review from "./review.ts"
import { oxlintStatus } from "./setup.ts"
import { makeDiagnostic } from "./shared.ts"

/**
 * The oxlint config file names, in precedence order.
 *
 * @since 0.0.0
 */
const OXLINT_CONFIG_NAMES = [".oxlintrc.json", ".oxlintrc", "oxlint.json"]

/**
 * Reads and parses the project's oxlint config, returning the parsed object
 * and the config file name, or `null` when no config is present.
 *
 * @since 0.0.0
 */
const readOxlintConfig = (
  projectDir: string
): { config: Record<string, unknown>; name: string } | null => {
  for (const name of OXLINT_CONFIG_NAMES) {
    const path = join(projectDir, name)
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      return { config: parsed, name }
    } catch {
      // An unparseable config is surfaced by the oxlintStatus contract as
      // `ambiguous`; the scopes are reported as empty.
      return { config: {}, name }
    }
  }
  return null
}

/**
 * Detects the oxlint configuration scopes (ignore patterns, overrides, and
 * rule settings) from the project's oxlint config. Read verbatim; never
 * rewritten.
 *
 * @since 0.0.0
 */
const detectOxlintScopes = (projectDir: string): OxlintScopes => {
  const loaded = readOxlintConfig(projectDir)
  if (loaded === null) {
    return makeOxlintScopes({ configPath: null })
  }
  const { config, name } = loaded
  const ignorePatterns = Array.isArray(config.ignorePatterns)
    ? config.ignorePatterns.filter((p): p is string => typeof p === "string")
    : []
  const overrides = Array.isArray(config.overrides)
    ? config.overrides.filter(
      (o): o is Record<string, unknown> => typeof o === "object" && o !== null
    )
    : []
  const ruleSettings = typeof config.rules === "object" && config.rules !== null
    ? (config.rules as Record<string, unknown>)
    : {}
  return makeOxlintScopes({ configPath: name, ignorePatterns, overrides, rules: ruleSettings })
}

/**
 * The configured rule ids from the oxlint config, keyed by provider prefix.
 *
 * @since 0.0.0
 */
const configuredRulesByProvider = (
  ruleSettings: Record<string, unknown>
): Record<string, Array<string>> => {
  const byProvider: Record<string, Array<string>> = {
    lens: [],
    foldstryx: [],
    stylex: []
  }
  for (const key of Object.keys(ruleSettings)) {
    if (key.startsWith("lens/")) byProvider.lens.push(key)
    else if (key.startsWith("foldstryx/")) byProvider.foldstryx.push(key)
    else if (key.startsWith("stylex/")) byProvider.stylex.push(key)
  }
  return byProvider
}

/**
 * Detects whether a provider is loaded by the project's oxlint config via a
 * matching `jsPlugins` entry.
 *
 * @since 0.0.0
 */
const providerLoaded = (config: Record<string, unknown>, needle: string): boolean =>
  Array.isArray(config.jsPlugins) &&
  config.jsPlugins.some((p) => typeof p === "string" && p.includes(needle))

/**
 * Builds the provider status list for the audit.
 *
 * Each of the Lens, Foldstryx, and StyleX providers is reported with whether
 * it is active (loaded by the project's oxlint config) and the provider's
 * configured rule ids. The Lens provider is always reported with its catalog
 * rule ids so the audit shows the canonical rules available even when the
 * project has not configured them.
 *
 * @since 0.0.0
 */
const buildProviders = (config: Record<string, unknown>): Array<{
  provider: string
  title: string
  active: boolean
  rules: Array<string>
}> => {
  const configured = configuredRulesByProvider(
    typeof config.rules === "object" && config.rules !== null
      ? (config.rules as Record<string, unknown>)
      : {}
  )
  const lensActive = providerLoaded(config, "lens") || configured.lens.length > 0
  const foldstryxActive = providerLoaded(config, "foldstryx") || configured.foldstryx.length > 0
  const stylexActive = providerLoaded(config, "stylex") || configured.stylex.length > 0
  return [
    {
      provider: lensProvider.id,
      title: lensProvider.title,
      active: lensActive,
      rules: configured.lens.length > 0 ? configured.lens : rules.map((r) => r.id)
    },
    {
      provider: foldstryxProvider.id,
      title: foldstryxProvider.title,
      active: foldstryxActive,
      rules: configured.foldstryx
    },
    {
      provider: stylexProvider.id,
      title: stylexProvider.title,
      active: stylexActive,
      rules: configured.stylex
    }
  ]
}

/**
 * Builds the equivalent-rule overlaps for the audit.
 *
 * An overlap is a Foldstryx rule that has an explicit Lens equivalent (from
 * the `foldstryxEquivalences` mapping) and is configured in the project's
 * oxlint config. The overlap is advisory and never mutates config; a Foldstryx
 * rule with no Lens equivalent is intentionally absent so project-specific
 * Foldstryx rules are preserved.
 *
 * @since 0.0.0
 */
const buildOverlaps = (config: Record<string, unknown>): Array<{
  providerRule: string
  canonicalRule: string
  rationale: string
}> => {
  const configured = configuredRulesByProvider(
    typeof config.rules === "object" && config.rules !== null
      ? (config.rules as Record<string, unknown>)
      : {}
  )
  const configuredSet = new Set(configured.foldstryx)
  return foldstryxEquivalences
    .filter((e) => configuredSet.has(e.providerRule))
    .map((e) => ({
      providerRule: e.providerRule,
      canonicalRule: e.canonicalRule,
      rationale: e.rationale
    }))
}

/**
 * Builds the unified-gate findings from the supplied oxlint diagnostics.
 *
 * Runs {@link Review.review} in unified mode over the diagnostics so the
 * project's config is preserved and equivalent Lens/Foldstryx diagnostics
 * collapse to one finding with a migration report. When oxlint is unavailable
 * (`error` is set) the gate findings are empty with the error surfaced.
 *
 * @since 0.0.0
 */
const buildGate = (gate: {
  diagnostics: Array<Review.OxlintDiagnostic>
  error: string | null
}): {
  findings: Array<import("../Finding.ts").Finding>
  migration: Array<import("../Adoption.ts").MigrationEntry>
  diagnostics: Array<import("../Finding.ts").Diagnostic>
  summary: import("../Adoption.ts").GateSummary
  status: number
  error: string | null
} => {
  if (gate.error !== null) {
    return {
      findings: [],
      migration: [],
      diagnostics: [],
      summary: makeGateSummary({ total: 0, errors: 0, warnings: 0 }),
      status: 0,
      error: gate.error
    }
  }
  const review = Review.review({
    input: Review.makeReviewInput({ diagnostics: gate.diagnostics }),
    mode: "unified"
  })
  return {
    findings: [...review.findings],
    migration: review.migration.entries.map((e) =>
      makeMigrationEntry({
        providerRule: e.providerRule,
        canonicalRule: e.canonicalRule,
        count: e.count,
        recommendation: e.recommendation
      })
    ),
    diagnostics: [...review.diagnostics],
    summary: makeGateSummary({
      total: review.summary.total,
      errors: review.summary.errors,
      warnings: review.summary.warnings
    }),
    status: review.status,
    error: null
  }
}

/**
 * Builds the actionable migration recommendations for the audit.
 *
 * Recommendations are derived from the audit state and are advisory; they
 * never mutate config. A configured Foldstryx rule with a Lens equivalent
 * yields a `migrate-overlap` recommendation to adopt the canonical Lens rule
 * while preserving project-specific Foldstryx/StyleX rules. A missing Lens
 * config yields a `configure-lens` recommendation. A missing/stale/partial
 * reference pack yields a `fetch-pack` recommendation. A missing Effect
 * dependency yields a `resolve-dependency` recommendation.
 *
 * @since 0.0.0
 */
const buildRecommendations = (args: {
  resolution: Resolver.Resolution
  pack: PackVerifier.PackVerificationResult
  oxlint: { status: "configured" | "missing" | "ambiguous" }
  overlaps: Array<{ providerRule: string; canonicalRule: string }>
}): Array<{ kind: RecommendationKind; message: string; detail: string | null }> => {
  const recommendations: Array<{
    kind: RecommendationKind
    message: string
    detail: string | null
  }> = []
  for (const overlap of args.overlaps) {
    recommendations.push({
      kind: "migrate-overlap",
      message: `Migrate ${overlap.providerRule} to ${overlap.canonicalRule}; ` +
        `Lens enforces the same rule with catalog evidence.`,
      detail: "Project-specific Foldstryx/StyleX rules without a Lens equivalent are preserved."
    })
  }
  if (args.oxlint.status === "missing") {
    recommendations.push({
      kind: "configure-lens",
      message:
        "No oxlint config with Lens rules found; configure the Lens plugin to adopt the unified gate.",
      detail: null
    })
  } else if (args.oxlint.status === "ambiguous") {
    recommendations.push({
      kind: "configure-lens",
      message:
        "The oxlint config is present but unreadable or unparseable; fix it to adopt the unified gate.",
      detail: null
    })
  }
  if (args.pack.status === "missing") {
    recommendations.push({
      kind: "fetch-pack",
      message:
        "No reference pack found for the resolved Effect version; fetch it to enable catalog evidence.",
      detail: Option.getOrNull(args.pack.message)
    })
  } else if (args.pack.status === "stale" || args.pack.status === "partial") {
    recommendations.push({
      kind: "fetch-pack",
      message: `Reference pack is ${args.pack.status}; refresh it to enable catalog evidence.`,
      detail: Option.getOrNull(args.pack.message)
    })
  }
  if (args.resolution.status === "missing") {
    recommendations.push({
      kind: "resolve-dependency",
      message: "No effect dependency declared; declare it to resolve the target Effect version.",
      detail: Option.getOrNull(args.resolution.detail)
    })
  }
  return recommendations
}

/**
 * Builds the diagnostics that drive the audit exit code.
 *
 * A missing Effect dependency and an unresolved/ambiguous workspace target are
 * blocking `error`s. A missing/stale/partial reference pack, an unparseable
 * oxlint config, and an unavailable oxlint binary are advisory `warning`s.
 *
 * @since 0.0.0
 */
const buildDiagnostics = (args: {
  resolution: Resolver.Resolution
  pack: PackVerifier.PackVerificationResult
  oxlint: { status: "configured" | "missing" | "ambiguous" }
  gateError: string | null
}): Array<ReturnType<typeof makeDiagnostic>> => {
  const diagnostics: Array<ReturnType<typeof makeDiagnostic>> = []
  switch (args.resolution.status) {
    case "missing":
      diagnostics.push(
        makeDiagnostic({
          id: "adoption-effect-missing",
          severity: "error",
          message: "no effect dependency declared in lockfile or package.json"
        })
      )
      break
    case "workspace-ambiguous":
      diagnostics.push(
        makeDiagnostic({
          id: "adoption-workspace-ambiguous",
          severity: "error",
          message: Option.getOrNull(args.resolution.detail) ??
            "workspace target is ambiguous; specify the full importer path"
        })
      )
      break
    case "workspace-unresolved":
      diagnostics.push(
        makeDiagnostic({
          id: "adoption-workspace-unresolved",
          severity: "error",
          message: Option.getOrNull(args.resolution.detail) ??
            "workspace target does not match any supported importer"
        })
      )
      break
    default:
      break
  }
  if (args.pack.status === "missing") {
    diagnostics.push(
      makeDiagnostic({
        id: "adoption-pack-missing",
        severity: "warning",
        message: Option.getOrNull(args.pack.message) ?? "no reference pack found"
      })
    )
  } else if (args.pack.status === "stale" || args.pack.status === "partial") {
    diagnostics.push(
      makeDiagnostic({
        id: `adoption-pack-${args.pack.status}`,
        severity: "warning",
        message: Option.getOrNull(args.pack.message) ?? `reference pack is ${args.pack.status}`
      })
    )
  }
  if (args.oxlint.status === "ambiguous") {
    diagnostics.push(
      makeDiagnostic({
        id: "adoption-oxlint-ambiguous",
        severity: "warning",
        message: "oxlint config present but unreadable or unparseable"
      })
    )
  }
  if (args.gateError !== null) {
    diagnostics.push(
      makeDiagnostic({
        id: "adoption-gate-unavailable",
        severity: "warning",
        message: args.gateError
      })
    )
  }
  return diagnostics
}

/**
 * Builds a read-only {@link AdoptionAudit} for a project/workspace.
 *
 * The unified-gate oxlint diagnostics are supplied by the adapter (the CLI
 * runs oxlint in unified mode); when omitted, the gate findings are empty.
 * The operation is strictly read-only and offline.
 *
 * @since 0.0.0
 */
export const buildAdoptionAudit = (args: {
  projectDir: string
  cacheDir: string
  workspace?: string | undefined
  gate?: { diagnostics: Array<Review.OxlintDiagnostic>; error: string | null }
}): AdoptionAudit => {
  const resolution = Resolver.resolveEffectIdentity(args.projectDir, {
    workspace: args.workspace
  })
  const pack = PackVerifier.verifyReferencePack({
    projectDir: args.projectDir,
    cacheDir: args.cacheDir,
    workspace: args.workspace
  })
  const oxlint = oxlintStatus(args.projectDir)
  const oxlintScopes = detectOxlintScopes(args.projectDir)
  const loaded = readOxlintConfig(args.projectDir)
  const config = loaded?.config ?? {}
  const providers = buildProviders(config)
  const overlaps = buildOverlaps(config)
  const gate = buildGate(
    args.gate ?? { diagnostics: [], error: null }
  )
  const recommendations = buildRecommendations({
    resolution,
    pack,
    oxlint: { status: oxlint.status },
    overlaps
  })
  const diagnostics = buildDiagnostics({
    resolution,
    pack,
    oxlint: { status: oxlint.status },
    gateError: gate.error
  })
  return makeAdoptionAudit({
    project: args.projectDir,
    workspace: args.workspace ?? null,
    resolution,
    pack,
    oxlint,
    oxlintScopes,
    providers: providers.map((p) => makeProviderStatus(p)),
    overlaps: overlaps.map((o) => makeRuleOverlap(o)),
    gate: makeGateFindings(gate),
    recommendations: recommendations.map((r) => makeRecommendation(r)),
    diagnostics
  })
}

export { AdoptionAudit, PackVerifier, Resolver, Review }
export type { Diagnostic } from "../Finding.ts"
