/**
 * Bind-aware AST guards shared by the Lens oxlint rules.
 *
 * These guards use AST structure and scope/binding information, never text
 * matching. They let the rules catch aliases and shadowing where the oxlint
 * scope API supports it.
 *
 * @since 0.0.0
 */
import type { ESTree, Scope, Variable } from "@oxlint/plugins"

/**
 * Reconstruct a static member chain, e.g. `a.b.c` -> `"a.b.c"`.
 * Returns `null` for computed or private member access.
 *
 * @since 0.0.0
 */
export const staticMemberChain = (
  node: ESTree.MemberExpression
): string | null => {
  if (node.computed) return null
  const propName = node.property.name
  const obj = node.object
  if (obj.type === "Identifier") return `${obj.name}.${propName}`
  if (obj.type === "MemberExpression") {
    const inner = staticMemberChain(obj)
    return inner === null ? null : `${inner}.${propName}`
  }
  return null
}

/**
 * The leftmost identifier of a (possibly chained) member expression, e.g.
 * `Eff.Effect.runPromise` -> `"Eff"`. Returns `null` for non-identifier bases.
 *
 * @since 0.0.0
 */
export const baseIdentifier = (
  node: ESTree.Expression
): string | null => {
  if (node.type === "Identifier") return node.name
  if (node.type === "MemberExpression") return baseIdentifier(node.object)
  return null
}

/**
 * Resolve `name` to its binding by walking the scope chain upward.
 * Returns `null` when no binding is found (a global reference).
 *
 * @since 0.0.0
 */
export const findVariableUp = (
  scope: Scope,
  name: string
): Variable | null => {
  let current: Scope | null = scope
  while (current !== null) {
    const variable = current.set.get(name)
    if (variable !== undefined) return variable
    current = current.upper
  }
  return null
}

/**
 * The import source if `name` (resolved in `scope`) is an import binding.
 * Returns `null` when `name` is not imported.
 *
 * @since 0.0.0
 */
export const importSourceOf = (
  name: string,
  scope: Scope
): string | null => {
  const variable = findVariableUp(scope, name)
  if (variable === null) return null
  const def = variable.defs.find((d) => d.type === "ImportBinding")
  if (def === undefined) return null
  const parent = def.parent
  if (parent === null || parent.type !== "ImportDeclaration") return null
  return parent.source.value
}

/**
 * True if `name` (resolved in `scope`) is imported from the Effect package
 * (`effect` or an `effect/...` subpath). Bind-aware, so a locally-declared
 * `Effect`/`Runtime` object does not satisfy the check.
 *
 * @since 0.0.0
 */
export const isEffectPackageImport = (
  name: string,
  scope: Scope
): boolean => {
  const source = importSourceOf(name, scope)
  return source !== null &&
    (source === "effect" || source.startsWith("effect/"))
}

/**
 * True when a resolved variable is a global binding (no defs, or only implicit
 * global defs). Local declarations always carry a concrete def type.
 *
 * @since 0.0.0
 */
const isGlobalBinding = (variable: Variable): boolean =>
  variable.defs.length === 0 ||
  variable.defs.every((d) => d.type === "ImplicitGlobalVariable")

const isGlobalObject = (name: string): boolean => name === "globalThis" || name === "global"

/**
 * True if `name` (resolved in `scope`) refers to the `Promise` global or to an
 * alias of it (e.g. `const P = Promise`). Used to ban `new Promise` /
 * `new P(...)` even when the constructor is spelled differently or aliased.
 *
 * @since 0.0.0
 */
const isPromiseReferenceInternal = (
  name: string,
  scope: Scope,
  visited: Set<string>
): boolean => {
  if (visited.has(name)) return false
  visited.add(name)
  const variable = findVariableUp(scope, name)
  if (variable === null) return name === "Promise"
  if (isGlobalBinding(variable)) return name === "Promise"
  return variable.defs.some((def) => {
    if (def.type !== "Variable") return false
    const declarator = def.node
    if (declarator.type !== "VariableDeclarator") return false
    const init = declarator.init
    if (init === null) return false
    // Destructuring: `const { Promise: P } = globalThis`
    if (declarator.id.type === "ObjectPattern") {
      const promiseProp = declarator.id.properties.find(
        (prop): prop is ESTree.BindingProperty =>
          prop.type === "Property" &&
          prop.key.type === "Identifier" &&
          prop.key.name === "Promise"
      )
      if (promiseProp === undefined) return false
      // Only the binding whose value identifier matches `name` is the Promise
      // alias; a sibling binding (e.g. `Map` in `{ Promise: P, Map: M }`) is not.
      const value = promiseProp.value
      if (value.type !== "Identifier" || value.name !== name) return false
      if (init.type === "Identifier") return isGlobalObject(init.name)
      if (init.type === "MemberExpression") {
        const chain = staticMemberChain(init)
        return chain === "globalThis" || chain === "global"
      }
      return false
    }
    if (init.type === "Identifier") {
      return isPromiseReferenceInternal(init.name, scope, visited)
    }
    if (init.type === "MemberExpression") {
      const chain = staticMemberChain(init)
      return chain === "Promise" ||
        chain === "globalThis.Promise" ||
        chain === "global.Promise"
    }
    return false
  })
}

/**
 * True if `name` (resolved in `scope`) refers to the `Promise` global or to an
 * alias of it (e.g. `const P = Promise`). Used to ban `new Promise` /
 * `new P(...)` even when the constructor is spelled differently or aliased.
 *
 * @since 0.0.0
 */
export const isPromiseReference = (
  name: string,
  scope: Scope
): boolean => isPromiseReferenceInternal(name, scope, new Set())
