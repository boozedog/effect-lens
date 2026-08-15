/**
 * A minimal Foldstryx oxlint plugin used as a test fixture.
 *
 * It is a stub that emits the three Foldstryx diagnostic codes Lens knows how
 * to migrate (`foldstryx(no-async-function)`, `foldstryx(no-await-expression)`,
 * `foldstryx(no-new-promise)`) so the `check` command can be exercised
 * end-to-end without requiring Foldstryx to be installed. It is test
 * infrastructure only and is excluded from the repository's own lint config.
 *
 * @since 0.0.0
 */
import type { CreateRule, ESTree, Plugin, Visitor } from "@oxlint/plugins"

const noAsyncFunction: CreateRule = {
  meta: { type: "suggestion", docs: { description: "Foldstryx: no async functions" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "Foldstryx: avoid async functions" })
    }
    return {
      FunctionDeclaration: (node: ESTree.Node) => {
        if (node.type === "FunctionDeclaration" && node.async) report(node)
      },
      FunctionExpression: (node: ESTree.Node) => {
        if (node.type === "FunctionExpression" && node.async) report(node)
      },
      ArrowFunctionExpression: (node: ESTree.Node) => {
        if (node.type === "ArrowFunctionExpression" && node.async) report(node)
      }
    } as Visitor
  }
}

const noAwaitExpression: CreateRule = {
  meta: { type: "suggestion", docs: { description: "Foldstryx: no await expressions" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "Foldstryx: avoid await" })
    }
    return {
      AwaitExpression: (node: ESTree.Node) => {
        if (node.type === "AwaitExpression") report(node)
      }
    } as Visitor
  }
}

const noNewPromise: CreateRule = {
  meta: { type: "suggestion", docs: { description: "Foldstryx: no new Promise" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "Foldstryx: avoid new Promise" })
    }
    return {
      NewExpression: (node: ESTree.Node) => {
        if (
          node.type === "NewExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "Promise"
        ) {
          report(node)
        }
      }
    } as Visitor
  }
}

/**
 * @since 0.0.0
 */
export const foldstryxPlugin: Plugin = {
  meta: { name: "foldstryx" },
  rules: {
    "no-async-function": noAsyncFunction,
    "no-await-expression": noAwaitExpression,
    "no-new-promise": noNewPromise
  }
}

export default foldstryxPlugin
