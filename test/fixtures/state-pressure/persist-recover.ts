// Positive fixture: a workflow with persistence and recovery.
declare const localStorage: {
  setItem(key: string, value: string): void
  getItem(key: string): string | null
}

const Effect = {
  sleep: (d: string) => ({ sleep: d }),
  retry: (self: unknown) => self
} as const

export type State = { kind: "idle" } | { kind: "running" } | { kind: "done" }
export type Event = { type: "start" } | { type: "finish" }

export const reducer = (state: State, event: Event): State => {
  switch (state.kind) {
    case "idle":
      return event.type === "start" ? { kind: "running" } : state
    case "running":
      return event.type === "finish" ? { kind: "done" } : state
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
    default:
      return state
  }
}

export const persist = (state: State): void => {
  localStorage.setItem("workflow", JSON.stringify(state))
}

export const restore = (): State => {
  const raw = localStorage.getItem("workflow")
  return raw ? (JSON.parse(raw) as State) : { kind: "idle" }
}
