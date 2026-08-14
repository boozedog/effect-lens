/**
 * Lens strict rule: `lens/no-await-expression`.
 *
 * Bans `await` expressions, except on the narrow, explicit, bind-aware Effect
 * interop bridge: `await Effect.runPromise(...)` where the receiver resolves to
 * an import binding from the `effect` package.
 *
 * This is a **Lens strict-policy** rule, not an upstream Effect rule. Upstream
 * Effect documents `Effect.runPromise` as the bridge from an Effect program
 * back into a `Promise`-based host (see the `Effect.d.ts` evidence). Lens
 * narrows that to the bind-aware bridge only.
 *
 * @since 0.0.0
 */
import { makeEvidence } from "../Provenance.ts"
import { makeRule } from "../Rule.ts"

/**
 * @since 0.0.0
 */
export const noAwaitExpressionRule = makeRule({
  id: "lens/no-await-expression",
  title: "No await expressions",
  kind: "lens-strict",
  severity: "error",
  rationale: "await on a Promise breaks Effect composition. The only allowed await is the " +
    "narrow, bind-aware Effect.runPromise bridge where the receiver is imported " +
    "from the effect package.",
  evidence: [
    makeEvidence({
      source: "effect/dist/Effect.d.ts",
      ref: "v4.0.0-rc.109",
      location: "Effect.d.ts:16270",
      snippet:
        "export declare const runPromise: <A, E>(effect: Effect<A, E>, options?: RunOptions | undefined) => Promise<A>"
    })
  ],
  exceptions: [
    "await Effect.runPromise(...) where the receiver is a bind-aware import " +
    "from the effect package."
  ]
})
