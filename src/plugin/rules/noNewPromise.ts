/**
 * Oxlint rule: `lens/no-new-promise`.
 *
 * Bans `new Promise(...)` and its equivalents (`new globalThis.Promise(...)`,
 * `new global.Promise(...)`, `const P = Promise; new P(...)`,
 * `const { Promise: P } = globalThis; new P(...)`). Bind-aware: aliases of the
 * `Promise` global are resolved through the scope so the ban cannot be
 * bypassed by renaming.
 *
 * @since 0.0.0
 */
import type { CreateRule, ESTree, Scope, Visitor } from "@oxlint/plugins"
import { isPromiseReference, staticMemberChain } from "../guards.ts"

const MESSAGE = "Avoid constructing Promises; Lens is Effect-first. Use Effect " +
  "(Deferred, Effect.acquireRelease, Effect.async) instead of manual Promise " +
  "construction. This covers `new Promise`, `new globalThis.Promise`, " +
  "`new global.Promise`, and aliased constructors (e.g. `const P = Promise; " +
  "new P(...)`)."

/**
 * @since 0.0.0
 */
export const noNewPromise: CreateRule = {
  meta: {
    type: "suggestion",
    docs: { description: MESSAGE }
  },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: MESSAGE })
    }
    return {
      NewExpression: (node: ESTree.Node) => {
        if (node.type !== "NewExpression") return
        const callee = node.callee
        if (callee.type === "Identifier") {
          const scope: Scope = context.sourceCode.getScope(callee)
          if (isPromiseReference(callee.name, scope)) {
            report(node)
          }
        } else if (callee.type === "MemberExpression") {
          const chain = staticMemberChain(callee)
          if (
            chain === "Promise" ||
            chain === "globalThis.Promise" ||
            chain === "global.Promise"
          ) {
            report(node)
          }
        }
      }
    } as Visitor
  }
}
