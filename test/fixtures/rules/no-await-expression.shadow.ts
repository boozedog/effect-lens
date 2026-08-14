// FAIL: a locally-declared `Effect` shadows the real import, so the bridge
// allowlist must NOT apply.
const Effect = {
  runPromise: (x: unknown): Promise<unknown> => Promise.resolve(x)
}

export async function shadowed(): Promise<unknown> {
  return await Effect.runPromise(1)
}
