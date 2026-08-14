/**
 * Oxlint rule: `lens/no-async-function`.
 *
 * Bans `async` functions. An `async` function returns a `Promise`, which does
 * not compose with Effect's synchronous composition primitives. Express the
 * same imperative flow with `Effect.gen` / `Effect.forEach` instead.
 *
 * @since 0.0.0
 */
import type { CreateRule, ESTree, Visitor } from "@oxlint/plugins"

const MESSAGE = "Avoid async functions; Lens is Effect-first. Compose with Effect " +
  "(Effect.gen, Effect.forEach, services) instead of async/await."

const isAsyncFunction = (node: ESTree.Node): boolean => {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return node.async === true
    default:
      return false
  }
}

/**
 * @since 0.0.0
 */
export const noAsyncFunction: CreateRule = {
  meta: {
    type: "suggestion",
    docs: { description: MESSAGE }
  },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: MESSAGE })
    }
    return {
      FunctionDeclaration: (node: ESTree.Node) => {
        if (isAsyncFunction(node)) report(node)
      },
      FunctionExpression: (node: ESTree.Node) => {
        if (isAsyncFunction(node)) report(node)
      },
      ArrowFunctionExpression: (node: ESTree.Node) => {
        if (isAsyncFunction(node)) report(node)
      }
    } as Visitor
  }
}
