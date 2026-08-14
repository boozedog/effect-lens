// Negative fixture: State + function reducer + a local named snapshot (no I/O).
// MUST NOT recommend.
export type State = { kind: "idle" } | { kind: "running" }

export function reducer(state: State): string {
  const snapshot = JSON.stringify(state)
  return snapshot
}
