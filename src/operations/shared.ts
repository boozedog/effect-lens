/**
 * Shared helpers for the read-only core operations.
 *
 * Version applicability and diagnostic construction are used by both
 * `lookup` and `design`, so they live here as a single source of truth rather
 * than being duplicated per operation.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Diagnostic } from "../Finding.ts"
import { Guidance } from "../Guidance.ts"
import { versionInWindow } from "../Version.ts"

/**
 * Whether a guidance record applies to the project's active Effect version.
 *
 * - `current` — the record's version window includes the active version.
 * - `stale` — the record's version window does not include the active version.
 * - `unknown` — the record carries no version applicability window, so
 *   applicability cannot be confirmed.
 *
 * @since 0.0.0
 */
export const VersionStatus = Schema.Literals(["current", "stale", "unknown"])
export type VersionStatus = Schema.Schema.Type<typeof VersionStatus>

/**
 * Computes whether a guidance record applies to `effectVersion` and its
 * {@link VersionStatus}. A record with no version window is treated as
 * inapplicable (`unknown`) so it is never silently used.
 *
 * @since 0.0.0
 */
export const versionStatusOf = (guidance: Guidance, effectVersion: string): {
  applicable: boolean
  versionStatus: VersionStatus
} => {
  const window = Option.getOrNull(guidance.appliesTo)
  if (window === null) {
    return { applicable: false, versionStatus: "unknown" }
  }
  const applicable = versionInWindow(effectVersion, window)
  return { applicable, versionStatus: applicable ? "current" : "stale" }
}

/**
 * Constructs a non-rule {@link Diagnostic} with no location.
 *
 * @since 0.0.0
 */
export const makeDiagnostic = (args: {
  id: string
  severity: "warning" | "error" | "off"
  message: string
}): Diagnostic =>
  new Diagnostic({
    id: args.id,
    severity: args.severity,
    message: args.message,
    location: Option.none()
  })

export { Guidance }
export type { Diagnostic } from "../Finding.ts"
