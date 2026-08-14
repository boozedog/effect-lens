/**
 * Shared severity level used by rules, findings, and diagnostics. One shared
 * model guarantees CLI, pi, and Git gates interpret severities identically.
 *
 * @since 0.0.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.0.0
 */
export const Severity = Schema.Literals(["off", "warning", "error"])
export type Severity = Schema.Schema.Type<typeof Severity>
