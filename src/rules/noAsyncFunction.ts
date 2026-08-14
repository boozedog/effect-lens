/**
 * Lens strict rule: `lens/no-async-function`.
 *
 * Bans `async` functions. An `async` function returns a `Promise`, which does
 * not compose with Effect's synchronous composition primitives. Effect code
 * expresses the same imperative flow with `Effect.gen` / `Effect.forEach`
 * instead of `async`/`await`.
 *
 * This is a **Lens strict-policy** rule, not an upstream Effect rule. Upstream
 * Effect does not ban `async` functions; it provides synchronous composition
 * primitives that make them unnecessary inside Effect programs. The evidence
 * below documents the composition alternative, not a universal upstream ban.
 *
 * @since 0.0.0
 */
import { makeEvidence } from "../Provenance.ts"
import { makeRule } from "../Rule.ts"

/**
 * @since 0.0.0
 */
export const noAsyncFunctionRule = makeRule({
  id: "lens/no-async-function",
  title: "No async functions",
  kind: "lens-strict",
  severity: "error",
  rationale: "An async function returns a Promise, which does not compose with Effect's " +
    "synchronous composition primitives. Express imperative flow with " +
    "Effect.gen / Effect.forEach instead of async/await.",
  evidence: [
    makeEvidence({
      source: "effect/ai-docs/src/01_effect/01_basics/01_effect-gen.ts",
      ref: "v4.0.0-rc.109",
      location: "01_effect-gen.ts:1",
      snippet: "Use `Effect.gen` to write code in an imperative style similar to async await."
    })
  ],
  exceptions: [
    "A narrow, explicit interop bridge module that returns Effect.runPromise(...) " +
    "to a non-Effect host may be exempted with a file-scoped Waiver."
  ]
})
