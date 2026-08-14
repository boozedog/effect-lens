/**
 * Lens oxlint plugin.
 *
 * Loaded by oxlint via the `jsPlugins` entry in `.oxlintrc.json`. The plugin
 * name is `lens`, so rules are referenced as `lens/no-async-function`,
 * `lens/no-await-expression`, and `lens/no-new-promise`. These IDs MUST match
 * the Lens rule catalog in `src/rules/`.
 *
 * The rules use AST and binding information (never text matching) and are
 * bind-aware: aliases and shadowing are caught where the oxlint scope API
 * supports it.
 *
 * @since 0.0.0
 */
import type { Plugin } from "@oxlint/plugins"
import { noAsyncFunction } from "./rules/noAsyncFunction.ts"
import { noAwaitExpression } from "./rules/noAwaitExpression.ts"
import { noNewPromise } from "./rules/noNewPromise.ts"

/**
 * @since 0.0.0
 */
export const lensPlugin: Plugin = {
  meta: { name: "lens" },
  rules: {
    "no-async-function": noAsyncFunction,
    "no-await-expression": noAwaitExpression,
    "no-new-promise": noNewPromise
  }
}

export default lensPlugin

export { AWAIT_ALLOWLIST } from "./allowlist.ts"
export {
  baseIdentifier,
  findVariableUp,
  importSourceOf,
  isEffectPackageImport,
  isPromiseReference,
  staticMemberChain
} from "./guards.ts"
export { noAsyncFunction } from "./rules/noAsyncFunction.ts"
export { noAwaitExpression } from "./rules/noAwaitExpression.ts"
export { noNewPromise } from "./rules/noNewPromise.ts"
