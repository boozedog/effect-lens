// @generated
// This file is generated. It MUST NOT recommend.
const Effect = {
  sleep: (d: string) => ({ sleep: d }),
  retry: (self: unknown) => self
} as const

export type State =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "done" }

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
