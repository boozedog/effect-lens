/**
 * Serialization helper for the CLI JSON output.
 *
 * Schema-backed values (findings, resolutions, drift reports, machine output)
 * must be encoded with `Schema.encodeSync` so `Option` fields serialize to
 * `null`/value rather than their internal `_tag` shape. This is the same
 * encoding the shared core uses for its JSON contract.
 *
 * @since 0.0.0
 */
import * as Schema from "effect/Schema"

/**
 * Encodes a Schema-backed value to its plain JSON representation.
 *
 * @since 0.0.0
 */
export const encode = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"]
): S["Encoded"] => Schema.encodeSync(schema)(value)
