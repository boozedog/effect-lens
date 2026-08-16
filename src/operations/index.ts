/**
 * Core operations: `lookup`, `review`, `design`, `statePressure`, `drift`,
 * `doctor`, `setup`, `setupApply`, `hooks`, `hookMutation`, and `adoption`.
 *
 * These are the adapter-independent operations that CLI, pi, and future MCP
 * adapters consume. They centralize policy and analysis logic so no surface
 * adapter duplicates it. `setup`, `setupApply`, `hooks`, and `hookMutation`
 * share the setup and hook-manager contracts; `setupApply` and `hookMutation`
 * are the explicit mutation surfaces while the rest are read-only. All results
 * are JSON-serializable and Schema-backed.
 *
 * @since 0.0.0
 */
export * as Adoption from "./adoption.ts"
export * as Design from "./design.ts"
export * as Doctor from "./doctor.ts"
export * as Drift from "./drift.ts"
export * as HookMutation from "./hookMutation.ts"
export * as Hooks from "./hooks.ts"
export * as Lookup from "./lookup.ts"
export * as Review from "./review.ts"
export * as Setup from "./setup.ts"
export * as SetupApply from "./setupApply.ts"
export * as Shared from "./shared.ts"
export * as StatePressure from "./statePressure.ts"
