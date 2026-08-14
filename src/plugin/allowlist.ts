/**
 * Narrow, explicit, bind-aware Effect interop bridge allowlist for `await`.
 *
 * Each entry is a method name allowed on a bind-aware import from the `effect`
 * package. The `no-await-expression` rule allows `await <effectImport>.<name>(...)`
 * only when the receiver resolves to an `effect` / `effect/*` import binding.
 * The local name is irrelevant, so `import { Effect as Eff }` and
 * `import * as Eff` are handled correctly.
 *
 * This is a NAME allowlist, not a path list: entries describe the Effect
 * methods that legitimately bridge the synchronous Effect world back into a
 * `Promise`-based host. A locally-declared or shadowed object cannot bypass the
 * ban because the receiver must be a real `effect` import.
 *
 * Add a name only when Effect offers no synchronous/declarative alternative
 * for the bridge call. Do NOT add file paths or growing path lists here.
 *
 * @since 0.0.0
 */
export const AWAIT_ALLOWLIST: ReadonlyArray<string> = [
  "runPromise"
]
