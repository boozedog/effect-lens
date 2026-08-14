// PASS: await on the narrow, bind-aware Effect.runPromise bridge is allowed.
import { Effect } from "effect"

export async function effectBridge(): Promise<number> {
  return await Effect.runPromise(Effect.succeed(1))
}
