/**
 * Read-only `design` operation: combine supplied analysis facts with relevant
 * guidance and return an advisory result with evidence and confidence.
 *
 * Design is advisory, never authoritative. It takes a requested feature, the
 * project's active Effect version, a set of {@link AnalysisFact} values
 * supplied by AST/type analysis, and the relevant guidance (typically the
 * output of a `lookup`). It returns ranked {@link DesignAdvice} with a
 * deterministic confidence and version applicability.
 *
 * The operation is extensible for state-pressure analysis (issue #10): facts
 * are kind-tagged, so a future state-pressure analyzer can supply facts with a
 * distinct `kind` without changing the operation contract. The confidence
 * computation is a pure function that can be extended to weight those facts.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "../Finding.ts"
import { Guidance } from "../Guidance.ts"
import { Evidence } from "../Provenance.ts"
import { makeDiagnostic, VersionStatus, versionStatusOf } from "./shared.ts"

/**
 * A single analysis fact supplied by AST/type analysis. `kind` is an open tag
 * naming the analyzer that produced the fact (e.g. `ast`, `type`, or a future
 * `state-pressure` analyzer); it is not a closed enum, so new analyzers can
 * introduce new kinds without changing this contract. `key`/`value` carry the
 * fact; `evidence` optionally ties it to a source.
 *
 * @since 0.0.0
 */
export class AnalysisFact extends Schema.Class<AnalysisFact>("AnalysisFact")({
  kind: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  value: Schema.String,
  evidence: Schema.OptionFromNullOr(Evidence)
}) {}

/**
 * Constructs an {@link AnalysisFact} value.
 *
 * @since 0.0.0
 */
export const makeAnalysisFact = (args: {
  kind: string
  key: string
  value: string
  evidence?: Evidence | null
}): AnalysisFact =>
  new AnalysisFact({
    kind: args.kind,
    key: args.key,
    value: args.value,
    evidence: Option.fromNullishOr(args.evidence)
  })

/**
 * A `design` request: the feature to design, the active Effect version, the
 * supplied analysis facts, and the relevant guidance to combine.
 *
 * @since 0.0.0
 */
export class DesignRequest extends Schema.Class<DesignRequest>("DesignRequest")({
  feature: Schema.NonEmptyString,
  effectVersion: Schema.NonEmptyString,
  facts: Schema.Array(AnalysisFact),
  guidance: Schema.Array(Guidance)
}) {}

/**
 * Constructs a {@link DesignRequest} value.
 *
 * @since 0.0.0
 */
export const makeDesignRequest = (args: {
  feature: string
  effectVersion: string
  facts?: Array<AnalysisFact>
  guidance?: Array<Guidance>
}): DesignRequest =>
  new DesignRequest({
    feature: args.feature,
    effectVersion: args.effectVersion,
    facts: args.facts ?? [],
    guidance: args.guidance ?? []
  })

/**
 * A single piece of design advice: the relevant {@link Guidance}, a
 * deterministic `confidence` (0..1), whether it `applies` to the active
 * Effect version, and its {@link VersionStatus}.
 *
 * @since 0.0.0
 */
export class DesignAdvice extends Schema.Class<DesignAdvice>("DesignAdvice")({
  guidance: Guidance,
  confidence: Schema.Number,
  applicable: Schema.Boolean,
  versionStatus: VersionStatus
}) {}

/**
 * The result of a {@link design}: the echoed feature and active version, the
 * ranked advice, and any diagnostics (e.g. incompatible or unverifiable
 * references).
 *
 * @since 0.0.0
 */
export class DesignResult extends Schema.Class<DesignResult>("DesignResult")({
  feature: Schema.NonEmptyString,
  effectVersion: Schema.NonEmptyString,
  advice: Schema.Array(DesignAdvice),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Deterministic confidence (0..1) for a guidance record given the supplied
 * analysis facts.
 *
 * The base confidence comes from the record's validation status: `validated`
 * is high, `unvalidated` is moderate, `conflict` is low. A fact whose `key`
 * matches the record's topic raises confidence slightly, and a fact whose
 * `value` matches the record's summary raises it a little more. Each fact key
 * and value is counted at most once. Conflict guidance is capped at a low
 * value, and a record that does not apply to the active Effect version is
 * capped low too, so neither is ever presented as high-confidence.
 *
 * @since 0.0.0
 */
export const confidenceOf = (args: {
  guidance: Guidance
  facts: ReadonlyArray<AnalysisFact>
  applicable: boolean
}): number => {
  const base = args.guidance.validationStatus === "validated"
    ? 0.8
    : args.guidance.validationStatus === "unvalidated"
    ? 0.5
    : 0.2
  const topic = args.guidance.topic.toLowerCase()
  const summary = args.guidance.summary.toLowerCase()
  const seenKeys = new Set<string>()
  const seenValues = new Set<string>()
  let delta = 0
  for (const fact of args.facts) {
    const key = fact.key.toLowerCase()
    const value = fact.value.toLowerCase()
    if (!seenKeys.has(key) && topic.includes(key)) {
      delta += 0.1
      seenKeys.add(key)
    }
    if (!seenValues.has(value) && summary.includes(value)) {
      delta += 0.05
      seenValues.add(value)
    }
  }
  const raw = Math.min(1, base + delta)
  const cap = args.guidance.validationStatus === "conflict" || !args.applicable ? 0.3 : 1
  return Math.min(raw, cap)
}

const compareTopics = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Runs a read-only `design` over the supplied request. Returns ranked advice
 * combining the relevant guidance with the analysis facts, annotated with
 * confidence and version applicability. Incompatible or unverifiable guidance
 * is surfaced with a diagnostic and marked `applicable: false`.
 *
 * @since 0.0.0
 */
export const design = (args: { request: DesignRequest }): DesignResult => {
  const { request } = args
  const diagnostics: Array<Diagnostic> = []
  const advice: Array<DesignAdvice> = []

  for (const guidance of request.guidance) {
    const { applicable, versionStatus } = versionStatusOf(guidance, request.effectVersion)
    if (!applicable) {
      diagnostics.push(
        makeDiagnostic({
          id: `design-incompatible-${guidance.id}`,
          severity: "warning",
          message: `guidance ${guidance.id} does not apply to effect ${request.effectVersion}`
        })
      )
    }
    if (guidance.validationStatus === "conflict") {
      diagnostics.push(
        makeDiagnostic({
          id: `design-conflict-${guidance.id}`,
          severity: "warning",
          message: `guidance ${guidance.id} is marked conflict`
        })
      )
    }
    advice.push(
      new DesignAdvice({
        guidance,
        confidence: confidenceOf({ guidance, facts: request.facts, applicable }),
        applicable,
        versionStatus
      })
    )
  }

  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target; sort a fresh array
  const sorted = advice.sort(
    (a, b) => b.confidence - a.confidence || compareTopics(a.guidance.topic, b.guidance.topic)
  )

  return new DesignResult({
    feature: request.feature,
    effectVersion: request.effectVersion,
    advice: sorted,
    diagnostics
  })
}

export { Guidance, VersionStatus }
export type { Evidence } from "../Provenance.ts"
