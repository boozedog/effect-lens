/**
 * A narrowly-scoped, reasoned, and optionally ratcheted exception to a rule.
 *
 * A waiver MUST carry a rule ID, a scope, and a reason. Lens provides no
 * blanket disable mechanism; every suppression is an explicit, attributable
 * {@link Waiver} record.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The breadth of a {@link Waiver}. Narrow is preferred: a file/path scoped
 * waiver is easier to audit than a global one.
 *
 * @since 0.0.0
 */
export const WaiverScope = Schema.Literals(["global", "path", "file"])
export type WaiverScope = Schema.Schema.Type<typeof WaiverScope>

/**
 * @since 0.0.0
 */
export class Waiver extends Schema.Class<Waiver>("Waiver")({
  id: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  scope: WaiverScope,
  path: Schema.OptionFromNullOr(Schema.NonEmptyString),
  reason: Schema.NonEmptyString,
  createdBy: Schema.NonEmptyString,
  expiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)
}) {}

/**
 * Constructs a {@link Waiver} value.
 *
 * @since 0.0.0
 */
export const makeWaiver = (args: {
  id: string
  rule: string
  scope: WaiverScope
  reason: string
  createdBy: string
  path?: string | null
  expiresAt?: Schema.Schema.Type<typeof Schema.DateTimeUtcFromString> | null
}): Waiver =>
  new Waiver({
    id: args.id,
    rule: args.rule,
    scope: args.scope,
    path: Option.fromNullishOr(args.path),
    reason: args.reason,
    createdBy: args.createdBy,
    expiresAt: Option.fromNullishOr(args.expiresAt)
  })
