/**
 * Read-only `lookup` operation: search ingested guidance and return compact,
 * evidence-backed matches with provenance and version applicability.
 *
 * Lookup never mutates packs, guidance, or network state. It ranks guidance
 * records by a deterministic token-overlap relevance score, then annotates
 * each match with whether it applies to the project's active Effect version.
 * Incompatible or unverifiable references are surfaced with a diagnostic and
 * marked `applicable: false` — they are never silently used.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "../Finding.ts"
import { Guidance } from "../Guidance.ts"
import { SourceKind } from "../Provenance.ts"
import { makeDiagnostic, VersionStatus, versionStatusOf } from "./shared.ts"

/**
 * A `lookup` request. `query` is free text matched against guidance topics and
 * summaries; `effectVersion` is the project's active Effect version used to
 * decide applicability; `limit` caps the number of returned matches; `source`
 * optionally restricts to a single source kind.
 *
 * @since 0.0.0
 */
export class LookupQuery extends Schema.Class<LookupQuery>("LookupQuery")({
  query: Schema.NonEmptyString,
  effectVersion: Schema.NonEmptyString,
  limit: Schema.Int,
  source: Schema.OptionFromNullOr(SourceKind)
}) {}

/**
 * Constructs a {@link LookupQuery} value. `limit` defaults to 10; `source`
 * defaults to no filter.
 *
 * @since 0.0.0
 */
export const makeLookupQuery = (args: {
  query: string
  effectVersion: string
  limit?: number
  source?: Schema.Schema.Type<typeof SourceKind> | null
}): LookupQuery => {
  const limit = args.limit !== undefined && args.limit > 0 ? Math.floor(args.limit) : 10
  return new LookupQuery({
    query: args.query,
    effectVersion: args.effectVersion,
    limit,
    source: Option.fromNullishOr(args.source)
  })
}

/**
 * A single ranked match: the matched {@link Guidance} record, its relevance
 * `score` (0..1), whether it `applies` to the active Effect version, its
 * `versionStatus`, and a `reason` describing its version applicability.
 *
 * @since 0.0.0
 */
export class LookupMatch extends Schema.Class<LookupMatch>("LookupMatch")({
  guidance: Guidance,
  score: Schema.Number,
  applicable: Schema.Boolean,
  versionStatus: VersionStatus,
  reason: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The result of a {@link lookup}: the echoed query and active version, the
 * ranked matches, and any diagnostics (e.g. incompatible or unverifiable
 * references).
 *
 * @since 0.0.0
 */
export class LookupResult extends Schema.Class<LookupResult>("LookupResult")({
  query: Schema.NonEmptyString,
  effectVersion: Schema.NonEmptyString,
  matches: Schema.Array(LookupMatch),
  diagnostics: Schema.Array(Diagnostic)
}) {}

const tokenize = (s: string): Array<string> =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0)

const topicTokens = (topic: string): Array<string> => tokenize(topic.replace(/\s*>\s*/g, " "))

const compareTopics = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Deterministic relevance score (0..1) for a guidance record against a query.
 * A query token found in the topic scores 2; in the summary scores 1. The
 * score is the matched weight over the maximum possible weight (every query
 * token in the topic). Returns 0 when no token matches.
 *
 * @internal
 */
export const relevanceScore = (query: string, guidance: Guidance): number => {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0
  const topic = new Set(topicTokens(guidance.topic))
  const summary = new Set(tokenize(guidance.summary))
  let matched = 0
  for (const token of tokens) {
    if (topic.has(token)) matched += 2
    else if (summary.has(token)) matched += 1
  }
  return matched / (tokens.length * 2)
}

/**
 * Runs a read-only `lookup` over the supplied ingested guidance. Returns
 * ranked matches annotated with version applicability and provenance, plus
 * diagnostics for incompatible, unverifiable, or low-confidence references.
 *
 * @since 0.0.0
 */
export const lookup = (args: {
  query: LookupQuery
  guidance: ReadonlyArray<Guidance>
}): LookupResult => {
  const { query } = args
  const diagnostics: Array<Diagnostic> = []
  const limit = Math.max(1, Math.floor(query.limit))
  const candidates = args.guidance.filter((g) => {
    const source = Option.getOrNull(query.source)
    return source === null || g.source === source
  })

  const scored = candidates
    .map((guidance) => {
      const { applicable, versionStatus } = versionStatusOf(guidance, query.effectVersion)
      return {
        guidance,
        score: relevanceScore(query.query, guidance),
        applicable,
        versionStatus
      }
    })
    .filter((entry) => entry.score > 0)
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh array
    .sort(
      (a, b) =>
        Number(b.applicable) - Number(a.applicable) ||
        b.score - a.score ||
        compareTopics(a.guidance.topic, b.guidance.topic)
    )

  const matches: Array<LookupMatch> = []
  for (const entry of scored.slice(0, limit)) {
    if (!entry.applicable) {
      diagnostics.push(
        makeDiagnostic({
          id: `lookup-incompatible-${entry.guidance.id}`,
          severity: "warning",
          message: `guidance ${entry.guidance.id} does not apply to effect ${query.effectVersion}`
        })
      )
    }
    if (entry.guidance.validationStatus === "conflict") {
      diagnostics.push(
        makeDiagnostic({
          id: `lookup-conflict-${entry.guidance.id}`,
          severity: "warning",
          message: `guidance ${entry.guidance.id} is marked conflict`
        })
      )
    }
    matches.push(
      new LookupMatch({
        guidance: entry.guidance,
        score: entry.score,
        applicable: entry.applicable,
        versionStatus: entry.versionStatus,
        reason: Option.some(
          entry.applicable
            ? `applies to effect ${query.effectVersion}`
            : `does not apply to effect ${query.effectVersion}`
        )
      })
    )
  }

  if (matches.length === 0) {
    diagnostics.push(
      makeDiagnostic({
        id: "lookup-no-matches",
        severity: "off",
        message: `no guidance matched query: ${query.query}`
      })
    )
  }

  return new LookupResult({
    query: query.query,
    effectVersion: query.effectVersion,
    matches,
    diagnostics
  })
}

export { Guidance, SourceKind }
export { VersionStatus }
export type { Diagnostic } from "../Finding.ts"
