// Positive fixture: independent boolean flags are the deciding signal.
// Without the flags this stays below the recommendation threshold.
export type Mode = { kind: "idle" } | { kind: "active" } | { kind: "done" }

export interface Flags {
  readonly isRunning: boolean
  readonly isPaused: boolean
}

export const advance = (mode: Mode, flags: Flags): Mode => {
  switch (mode.kind) {
    case "idle":
      return flags.isRunning ? { kind: "active" } : mode
    case "active":
      return flags.isPaused ? mode : { kind: "done" }
    case "done":
      return mode
  }
}

export const advanceAgain = (mode: Mode): Mode => {
  switch (mode.kind) {
    case "idle":
      return mode
    case "active":
      return { kind: "done" }
    case "done":
      return mode
  }
}
