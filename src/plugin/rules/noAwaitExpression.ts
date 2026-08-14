/**
 * Oxlint rule: `lens/no-await-expression`.
 *
 * Bans `AwaitExpression`, except when the awaited value is a call on an
 * allowlisted method (`runPromise`) of a bind-aware import from the `effect`
 * package. The local name is irrelevant, so `import { Effect as Eff }` and
 * `import * as Eff` are handled correctly.
 *
 * The allowlist is BIND-AWARE: the awaited object must resolve to an import
 * binding from the `effect` package, so a locally-declared or shadowed object
 * cannot bypass the ban.
 *
 * @since 0.0.0
 */
import type { CreateRule, ESTree, Scope, Visitor } from "@oxlint/plugins"
import { AWAIT_ALLOWLIST } from "../allowlist.ts"
import { baseIdentifier, isEffectPackageImport } from "../guards.ts"

const MESSAGE = "Avoid `await`; Lens is Effect-first. `await` is only allowed on the " +
  "allowlisted Effect bridge call (runPromise) where the receiver is imported " +
  "from the effect package. See AWAIT_ALLOWLIST in src/plugin/allowlist.ts."

/**
 * @since 0.0.0
 */
export const noAwaitExpression: CreateRule = {
  meta: {
    type: "suggestion",
    docs: { description: MESSAGE }
  },
  create(context) {
    const report = (node: ESTree.Node): void => {
      context.report({ node, message: MESSAGE })
    }
    return {
      AwaitExpression: (node: ESTree.Node) => {
        if (node.type !== "AwaitExpression") return
        const argument = node.argument
        if (argument.type !== "CallExpression") {
          report(node)
          return
        }
        const callee = argument.callee
        if (callee.type !== "MemberExpression") {
          report(node)
          return
        }
        if (callee.computed) {
          report(node)
          return
        }
        const prop = callee.property
        if (prop.type !== "Identifier") {
          report(node)
          return
        }
        const base = baseIdentifier(callee.object)
        if (base === null) {
          report(node)
          return
        }
        const scope: Scope = context.sourceCode.getScope(callee)
        const allowlisted = AWAIT_ALLOWLIST.includes(prop.name)
        if (allowlisted && isEffectPackageImport(base, scope)) {
          return
        }
        report(node)
      }
    } as Visitor
  }
}
