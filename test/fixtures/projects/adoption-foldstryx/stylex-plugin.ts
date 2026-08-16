/**
 * A minimal StyleX oxlint plugin used as a test fixture.
 *
 * It is a stub that emits a representative subset of the official
 * `@stylexjs/eslint-plugin` diagnostic codes Lens knows how to recognize
 * (`stylex(valid-styles)`, `stylex(no-unused)`, `stylex(sort-keys)`) so the
 * `check` command can be exercised end-to-end without requiring StyleX to be
 * installed. It is test infrastructure only and is excluded from the
 * repository's own lint config.
 *
 * @since 0.0.0
 */
import type { CreateRule, ESTree, Plugin, Visitor } from "@oxlint/plugins"

const validStyles: CreateRule = {
  meta: { type: "suggestion", docs: { description: "StyleX: validate stylex.create styles" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "StyleX: invalid style value in stylex.create" })
    }
    return {
      CallExpression: (node: ESTree.Node) => {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "stylex" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "create"
        ) {
          report(node)
        }
      }
    } as Visitor
  }
}

const noUnused: CreateRule = {
  meta: { type: "suggestion", docs: { description: "StyleX: no unused styles" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "StyleX: unused style definition" })
    }
    return {
      VariableDeclarator: (node: ESTree.Node) => {
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
          report(node)
        }
      }
    } as Visitor
  }
}

const sortKeys: CreateRule = {
  meta: { type: "suggestion", docs: { description: "StyleX: sort style keys" } },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: "StyleX: style keys are not sorted" })
    }
    return {
      ObjectExpression: (node: ESTree.Node) => {
        if (node.type === "ObjectExpression") report(node)
      }
    } as Visitor
  }
}

/**
 * @since 0.0.0
 */
export const stylexPlugin: Plugin = {
  meta: { name: "stylex" },
  rules: {
    "valid-styles": validStyles,
    "no-unused": noUnused,
    "sort-keys": sortKeys
  }
}

export default stylexPlugin
