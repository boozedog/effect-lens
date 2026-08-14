// Negative fixture: a small status/handle workflow with a stray Effect call.
// This MUST NOT recommend.
const Effect = {
  retry: (self: unknown) => self,
  gen: (f: () => unknown) => f()
} as const

export type Status = "idle" | "loading" | "done"

export function handle(status: Status): unknown {
  return Effect.retry(Effect.gen(() => status))
}
