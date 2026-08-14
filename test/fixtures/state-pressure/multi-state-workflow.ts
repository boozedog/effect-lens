// Positive fixture: a multi-state workflow with event handling and
// state-dependent Effects. This SHOULD recommend `@typeonce/effect-machine`.
// A minimal local Effect stub keeps the fixture self-contained and compiling.
const Effect = {
  sleep: (d: string) => ({ sleep: d }),
  retry: (self: unknown) => self,
  forkDaemon: (self: unknown) => ({ fork: self })
} as const

export type State =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly attempt: number }
  | { readonly kind: "paused" }
  | { readonly kind: "done" }

export type Event =
  | { readonly type: "start" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "finish" }

export const reducer = (state: State, event: Event): State => {
  switch (state.kind) {
    case "idle":
      return event.type === "start" ? { kind: "running", attempt: 1 } : state
    case "running":
      return event.type === "pause" ? { kind: "paused" } : state
    case "paused":
      return event.type === "resume" ? { kind: "running", attempt: 1 } : state
    case "done":
      return state
    default:
      return state
  }
}

export const run = (state: State): unknown => {
  switch (state.kind) {
    case "running":
      return Effect.retry(Effect.sleep("1 second"))
    case "paused":
      return Effect.forkDaemon(Effect.sleep("1 second"))
    default:
      return state
  }
}

export const persistState = (state: State): unknown => {
  const snapshot = JSON.stringify(state)
  return snapshot
}
