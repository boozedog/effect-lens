/**
 * Lens strict rule catalog.
 *
 * The canonical registry of strict Effect AST/behavior rules Lens ships. Each
 * entry is a {@link Rule} value whose `id` is the stable identifier used by the
 * oxlint plugin, the CLI, pi, and Git gates. The plugin rule IDs MUST match
 * these catalog IDs exactly.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import type { Rule } from "../Rule.ts"
import { noAsyncFunctionRule } from "./noAsyncFunction.ts"
import { noAwaitExpressionRule } from "./noAwaitExpression.ts"
import { noNewPromiseRule } from "./noNewPromise.ts"

/**
 * All Lens strict rules in catalog order.
 *
 * @since 0.0.0
 */
export const rules: ReadonlyArray<Rule> = [
  noAsyncFunctionRule,
  noAwaitExpressionRule,
  noNewPromiseRule
]

/**
 * Looks up a rule by its stable id.
 *
 * @since 0.0.0
 */
export const findRule = (id: string): Option.Option<Rule> =>
  Option.fromNullishOr(rules.find((rule) => rule.id === id))

export type { Rule } from "../Rule.ts"
export { noAsyncFunctionRule } from "./noAsyncFunction.ts"
export { noAwaitExpressionRule } from "./noAwaitExpression.ts"
export { noNewPromiseRule } from "./noNewPromise.ts"
