// PASS: no async functions.
import { Effect } from "effect"

export function sync(): Effect.Effect<number> {
  return Effect.succeed(1)
}

export const arrow = (): number => 1

export const method = {
  run(): number {
    return 1
  }
}
