// Negative fixture: State + function reducer + Effect.gen. MUST NOT recommend.
const Effect = {
  gen: (f: () => unknown) => f()
} as const

export type State = { kind: "idle" } | { kind: "running" }

export function reducer(state: State): unknown {
  return Effect.gen(() => state)
}
