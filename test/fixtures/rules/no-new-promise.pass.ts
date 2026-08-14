// PASS: no manual Promise construction.
import { Deferred, Effect } from "effect"

export const program = Effect.gen(function*() {
  const deferred = yield* Deferred.make<number>()
  yield* Deferred.succeed(deferred, 1)
  return yield* Deferred.await(deferred)
})
