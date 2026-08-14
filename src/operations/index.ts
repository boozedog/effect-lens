/**
 * Read-only core operations: `lookup`, `review`, `design`, and
 * `statePressure`.
 *
 * These are the adapter-independent operations that CLI, pi, and future MCP
 * adapters consume. They centralize policy and analysis logic so no surface
 * adapter duplicates it. All operations are read-only and produce
 * JSON-serializable Schema-backed results.
 *
 * @since 0.0.0
 */
export * as Design from "./design.ts"
export * as Lookup from "./lookup.ts"
export * as Review from "./review.ts"
export * as Shared from "./shared.ts"
export * as StatePressure from "./statePressure.ts"
