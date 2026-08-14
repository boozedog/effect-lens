/**
 * Lens strict rule: `lens/no-new-promise`.
 *
 * Bans manual `Promise` construction: `new Promise(...)`, `new globalThis.Promise(...)`,
 * and aliased constructors (e.g. `const P = Promise; new P(...)`). Manual Promise
 * construction bypasses Effect's structured concurrency; use `Deferred` or
 * `Effect.async` instead.
 *
 * This is a **Lens strict-policy** rule, not an upstream Effect rule. Upstream
 * Effect provides `Deferred` as the structured-concurrency alternative to a
 * manually-constructed `Promise`; the evidence documents that alternative.
 *
 * @since 0.0.0
 */
import { makeEvidence } from "../Provenance.ts"
import { makeRule } from "../Rule.ts"

/**
 * @since 0.0.0
 */
export const noNewPromiseRule = makeRule({
  id: "lens/no-new-promise",
  title: "No new Promise",
  kind: "lens-strict",
  severity: "error",
  rationale: "Manual Promise construction bypasses Effect's structured concurrency. Use " +
    "Deferred or Effect.async to coordinate asynchronous work inside Effect.",
  evidence: [
    makeEvidence({
      source: "effect/dist/Deferred.d.ts",
      ref: "v4.0.0-rc.109",
      location: "Deferred.d.ts:1",
      snippet: "A Deferred<A, E> starts empty, can be completed exactly once ... Awaiting a " +
        "Deferred suspends the fiber instead of blocking an operating-system thread."
    })
  ],
  exceptions: []
})
