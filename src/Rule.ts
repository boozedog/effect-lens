/**
 * Rule catalog metadata: every strict Effect AST/behavior rule Lens ships.
 *
 * Each rule records its kind (upstream-aligned vs Lens strict policy), its
 * severity, its rationale, its upstream/footgun evidence, and its documented
 * exceptions. Rule IDs are stable and are the same value used by CLI, pi, and
 * Git gates.
 *
 * @since 0.0.0
 */
import * as Schema from "effect/Schema"
import { Evidence } from "./Provenance.ts"
import { Severity } from "./Severity.ts"

/**
 * Whether a rule reflects upstream Effect practice or adds Lens strict policy
 * on top of it. A rule MUST NOT be labeled `upstream-aligned` without evidence
 * from the Effect repository or published tooling.
 *
 * @since 0.0.0
 */
export const RuleKind = Schema.Literals(["upstream-aligned", "lens-strict"])
export type RuleKind = Schema.Schema.Type<typeof RuleKind>

/**
 * @since 0.0.0
 */
export class Rule extends Schema.Class<Rule>("Rule")({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  kind: RuleKind,
  severity: Severity,
  rationale: Schema.NonEmptyString,
  evidence: Schema.Array(Evidence),
  exceptions: Schema.Array(Schema.NonEmptyString)
}) {}

/**
 * Constructs a {@link Rule} value.
 *
 * @since 0.0.0
 */
export const makeRule = (args: {
  id: string
  title: string
  kind: RuleKind
  severity: Schema.Schema.Type<typeof Severity>
  rationale: string
  evidence?: Array<Evidence>
  exceptions?: Array<string>
}): Rule =>
  new Rule({
    id: args.id,
    title: args.title,
    kind: args.kind,
    severity: args.severity,
    rationale: args.rationale,
    evidence: args.evidence ?? [],
    exceptions: args.exceptions ?? []
  })

export { Severity }
export type { Severity as SeverityType } from "./Severity.ts"
