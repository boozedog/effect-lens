// Positive fixture: independent boolean flags that suggest parallel state.
// This SHOULD recommend `@typeonce/effect-machine`.
const Effect = {
  sleep: (d: string) => ({ sleep: d }),
  retry: (self: unknown) => self
} as const

export type Mode =
  | { readonly kind: "idle" }
  | { readonly kind: "active" }
  | { readonly kind: "done" }

export interface WorkflowFlags {
  readonly isRunning: boolean
  readonly isPaused: boolean
  readonly isComplete: boolean
  readonly hasError: boolean
}

export const advance = (mode: Mode, flags: WorkflowFlags): unknown => {
  switch (mode.kind) {
    case "idle":
      return flags.isRunning ? Effect.retry(Effect.sleep("1 second")) : mode
    case "active":
      return flags.isPaused ? mode : Effect.sleep("1 second")
    case "done":
      return flags.isComplete ? mode : flags.hasError
  }
}

export const advanceAgain = (mode: Mode): unknown => {
  switch (mode.kind) {
    case "idle":
      return mode
    case "active":
      return Effect.sleep("1 second")
    case "done":
      return mode
  }
}
