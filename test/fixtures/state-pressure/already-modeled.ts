// Suppression fixture: code already using a state-machine library.
// This MUST NOT recommend even though it has multiple state-pressure signals.
import { createMachine } from "./xstate.ts"

const Effect = {
  sleep: (d: string) => ({ sleep: d }),
  retry: (self: unknown) => self
} as const

export type State =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "done" }

export const machine = createMachine({
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: { on: { FINISH: "done" } },
    done: {}
  }
})

export const reducer = (state: State): State => {
  switch (state.kind) {
    case "idle":
      return state
    case "running":
      return state
    case "done":
      return state
  }
}

export const run = (state: State): unknown => {
  switch (state.kind) {
    case "idle":
      return state
    case "running":
      return Effect.retry(Effect.sleep("1 second"))
    case "done":
      return state
  }
}
