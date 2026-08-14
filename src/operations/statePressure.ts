/**
 * Read-only state-pressure analysis for the `design` surface (issue #10).
 *
 * This is the first vertical slice of a state-pressure analyzer. It is a
 * single-file, AST/type-aware heuristic that detects combinations of growing
 * finite-state workflow complexity and, when enough overlapping signals are
 * present, emits an advisory recommendation for `@typeonce/effect-machine`.
 *
 * The analysis is strictly advisory: it never mutates source, never emits
 * strict `lens-strict` findings, and never performs migration or code
 * generation. It produces {@link AnalysisFact} values (kind `state-pressure`)
 * that flow into the existing `design` operation, plus a
 * {@link StatePressureResult} carrying the deterministic score, confidence,
 * and an explicit effect-machine recommendation when warranted.
 *
 * Scope and limitations (see `docs/state-pressure.md`):
 * - Single-file only. Cross-file transition aggregation is a later slice.
 * - Conditional transitions are detected as `switch` statements and
 *   `if`/`else` comparisons over a shared discriminator base.
 * - The heuristic is intentionally conservative: a single union or a single
 *   switch MUST NOT produce a recommendation.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as ts from "typescript"
import { makeGuidance } from "../Guidance.ts"
import { makeEvidence } from "../Provenance.ts"
import {
  AnalysisFact,
  design,
  DesignAdvice,
  DesignRequest,
  DesignResult,
  makeAnalysisFact
} from "./design.ts"

/**
 * Discriminator names that suggest a finite-state workflow.
 *
 * @since 0.0.0
 */
const DISCRIMINATOR_NAMES = new Set(["state", "status", "phase", "mode"])

/**
 * Discriminant property names that mark a discriminated-union access.
 *
 * @since 0.0.0
 */
const DISCRIMINATOR_PROPS = new Set(["kind", "type", "tag", "status", "state", "phase", "mode"])

/**
 * Event/command/reducer-like type names that suggest a message protocol.
 *
 * @since 0.0.0
 */
const EVENT_NAMES = new Set(["event", "command", "action", "message", "msg"])

/**
 * Function names that suggest a reducer/transition protocol.
 *
 * @since 0.0.0
 */
const REDUCER_NAMES = new Set([
  "reducer",
  "reduce",
  "handle",
  "transition",
  "onevent",
  "oncommand",
  "onaction",
  "onmessage"
])

/**
 * Effect call patterns that indicate state-dependent behavior: retries,
 * timers, queues, fibers, scheduling, and scoped resources.
 *
 * Ubiquitous constructors (`Effect.gen`, `Effect.suspend`, `Effect.scoped`,
 * `Effect.merge`) are deliberately excluded: they appear in almost every
 * Effect program and would otherwise over-trigger the signal. Effects are
 * only counted when they occur inside a transition over a discriminator (see
 * `analyzeStatePressure`), so a small status/handle workflow with a stray
 * `Effect.retry` does not recommend.
 *
 * @since 0.0.0
 */
const EFFECT_CALL_PATTERNS = [
  "Effect.retry",
  "Effect.sleep",
  "Effect.fork",
  "Effect.forkDaemon",
  "Effect.repeat",
  "Effect.schedule",
  "Effect.timeout",
  "Effect.timer",
  "Effect.race",
  "Effect.acquireRelease",
  "Effect.addFinalizer",
  "Effect.ensuring",
  "Effect.delay",
  "Queue.offer",
  "Queue.take",
  "Queue.takeBetween",
  "Queue.offerAll",
  "setTimeout",
  "setInterval"
]

/**
 * Substrings that indicate persistence or recovery of workflow state.
 *
 * @since 0.0.0
 */
const PERSISTENCE_PATTERNS = [
  "persist",
  "recover",
  "restore",
  "snapshot",
  "localStorage",
  "sessionStorage",
  "writeFile",
  "readFile"
]

/**
 * Bare function names that indicate persistence or recovery when called
 * directly (e.g. `writeFile(...)`, `persist(...)`).
 *
 * @since 0.0.0
 */
const PERSISTENCE_FN_NAMES = new Set([
  "persist",
  "recover",
  "restore",
  "snapshot",
  "writeFile",
  "readFile"
])

/**
 * Boolean flag names that suggest parallel or mutually exclusive modes.
 *
 * @since 0.0.0
 */
const FLAG_PATTERN =
  /^(is|has|can|should|did|was|will)[A-Z]|(Enabled|Active|Ready|Done|Pending|Loading|Visible|Open|Selected|Checked|Valid|Error|Busy|Running|Complete|Failed|Success|Initialized|Connected|Disconnected|Mounted|Submitted|Dirty|Clean)$/

/**
 * State-machine libraries whose presence suppresses a recommendation.
 *
 * @since 0.0.0
 */
const STATE_MACHINE_LIBS = [
  "@typeonce/effect-machine",
  "xstate",
  "@xstate",
  "robot3",
  "stately",
  "@state-adapt",
  "@zag-js/machine",
  "@statelyai"
]

/**
 * The closed set of state-pressure signal kinds the analyzer can emit.
 *
 * @since 0.0.0
 */
export const StatePressureSignalKind = Schema.Literals([
  "discriminated-union",
  "repeated-switch",
  "event-protocol",
  "state-dependent-effect",
  "boolean-flags",
  "persistence",
  "transition-spread"
])
export type StatePressureSignalKind = Schema.Schema.Type<typeof StatePressureSignalKind>

/**
 * Per-signal weight used to compute the deterministic state-pressure score.
 *
 * @since 0.0.0
 */
const SIGNAL_WEIGHTS: Record<StatePressureSignalKind, number> = {
  "discriminated-union": 1.0,
  "repeated-switch": 1.0,
  "event-protocol": 1.0,
  "state-dependent-effect": 1.0,
  "boolean-flags": 0.8,
  "persistence": 1.0,
  "transition-spread": 0.8
}

/**
 * Minimum score required before a recommendation is offered.
 *
 * @since 0.0.0
 */
const RECOMMEND_SCORE = 3.0

/**
 * Minimum number of distinct signal kinds required before a recommendation is
 * offered. A single union or a single switch MUST NOT recommend.
 *
 * @since 0.0.0
 */
const RECOMMEND_KINDS = 2

/**
 * A single detected state-pressure signal with its source evidence.
 *
 * @since 0.0.0
 */
export class StatePressureSignal extends Schema.Class<StatePressureSignal>("StatePressureSignal")({
  kind: StatePressureSignalKind,
  name: Schema.NonEmptyString,
  count: Schema.Number,
  location: Schema.OptionFromNullOr(Schema.NonEmptyString),
  snippet: Schema.OptionFromNullOr(Schema.String)
}) {}

/**
 * The result of a single-file state-pressure analysis.
 *
 * `signals` lists the detected signals with evidence; `score` and `confidence`
 * are deterministic; `recommendation` is true only when enough overlapping
 * signals are present and the file is not suppressed; `facts` are the
 * `state-pressure` {@link AnalysisFact} values that flow into `design`.
 *
 * @since 0.0.0
 */
export class StatePressureResult extends Schema.Class<StatePressureResult>("StatePressureResult")({
  file: Schema.NonEmptyString,
  signals: Schema.Array(StatePressureSignal),
  score: Schema.Number,
  confidence: Schema.Number,
  recommendation: Schema.Boolean,
  message: Schema.OptionFromNullOr(Schema.NonEmptyString),
  suppressed: Schema.Boolean,
  suppressionReason: Schema.OptionFromNullOr(Schema.NonEmptyString),
  facts: Schema.Array(AnalysisFact)
}) {}

/**
 * A raw transition observation (switch or conditional comparison) over a
 * discriminator base.
 *
 * @since 0.0.0
 */
interface TransitionObs {
  base: string
  line: number
  snippet: string
  fn: string | null
}

/**
 * A raw named observation (union, enum, event type, reducer, effect call,
 * persistence site).
 *
 * @since 0.0.0
 */
interface NamedObs {
  name: string
  line: number
  snippet: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Whether a type node is a literal type (string/number/boolean literal). The
 * TypeScript parser wraps `"idle"` in a `LiteralTypeNode`, so both the
 * wrapper and the bare literal kinds are accepted.
 *
 * @since 0.0.0
 */
const isLiteralType = (t: ts.TypeNode): boolean => {
  if (ts.isLiteralTypeNode(t)) {
    const k = t.literal.kind
    return (
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NumericLiteral ||
      k === ts.SyntaxKind.TrueKeyword ||
      k === ts.SyntaxKind.FalseKeyword
    )
  }
  const k = t.kind
  return (
    k === ts.SyntaxKind.StringLiteral ||
    k === ts.SyntaxKind.NumericLiteral ||
    k === ts.SyntaxKind.TrueKeyword ||
    k === ts.SyntaxKind.FalseKeyword
  )
}

/**
 * Returns the root identifier of a switch/conditional discriminant expression.
 * For `switch (state.kind)` this is `state`; for `switch (status)` it is
 * `status`.
 *
 * @since 0.0.0
 */
const switchBase = (expr: ts.Expression): string | null => {
  if (ts.isIdentifier(expr)) {
    return expr.text
  }
  if (ts.isPropertyAccessExpression(expr)) {
    let root: ts.Expression = expr.expression
    while (ts.isPropertyAccessExpression(root)) {
      root = root.expression
    }
    return ts.isIdentifier(root) ? root.text : null
  }
  return null
}

/**
 * Returns the root identifier of an `if` condition that compares a
 * discriminator against a value, e.g. `if (state.kind === "idle")`. Unwraps
 * `===`/`!==`/`==`/`!=` and the identifier/property-access operand, but only
 * when the left operand is a known discriminator (a `kind`/`type`/`tag`
 * access or a `state`/`status`/`phase`/`mode` identifier), so an unrelated
 * boolean like `if (ok === true)` is not treated as a transition.
 *
 * @since 0.0.0
 */
const conditionalBase = (expr: ts.Expression): string | null => {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      const left = expr.left
      const isDiscriminator =
        (ts.isPropertyAccessExpression(left) && DISCRIMINATOR_PROPS.has(left.name.text)) ||
        (ts.isIdentifier(left) && DISCRIMINATOR_NAMES.has(left.text.toLowerCase()))
      return isDiscriminator ? switchBase(left) : null
    }
  }
  return switchBase(expr)
}

/**
 * Whether a union type is discriminated: at least two object members share a
 * property that carries a literal type in at least one member.
 *
 * @since 0.0.0
 */
const hasDiscriminant = (union: ts.UnionTypeNode): boolean => {
  const members = union.types
  if (members.length < 2) {
    return false
  }
  const objMembers = members.filter(ts.isTypeLiteralNode)
  if (objMembers.length < 2) {
    return false
  }
  const propNames = new Set<string>()
  for (const m of objMembers) {
    for (const p of m.members) {
      if (ts.isPropertySignature(p)) {
        propNames.add(p.name.getText())
      }
    }
  }
  for (const prop of propNames) {
    const present = objMembers.filter((m) =>
      m.members.some((p) => ts.isPropertySignature(p) && p.name.getText() === prop)
    )
    if (present.length < 2) {
      continue
    }
    const hasLiteral = present.some((m) => {
      const p = m.members.find((x) => ts.isPropertySignature(x) && x.name.getText() === prop)
      if (!p || !ts.isPropertySignature(p) || !p.type) {
        return false
      }
      return isLiteralType(p.type)
    })
    if (hasLiteral) {
      return true
    }
  }
  return false
}

/**
 * The name of the function enclosing a node, if any.
 *
 * @since 0.0.0
 */
const functionNameOf = (node: ts.Node, sf: ts.SourceFile): string | null => {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sf) ?? null
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text
    }
    return null
  }
  return null
}

/**
 * Whether a file should be suppressed from a recommendation: generated code,
 * tests, or code already importing a state-machine library.
 *
 * State-machine usage is detected from import/require declarations (not from
 * comments or arbitrary source text), so a comment that merely mentions a
 * library does not suppress a recommendation.
 *
 * @since 0.0.0
 */
const suppressionOf = (
  file: string,
  source: string,
  usesStateMachineLib: boolean
): string | null => {
  const lower = file.toLowerCase()
  if (lower.includes(".gen.") || lower.includes("generated")) {
    return "generated code"
  }
  if (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/test/") ||
    lower.includes("/spec/") ||
    lower.startsWith("test/")
  ) {
    return "test file"
  }
  const header = source.slice(0, 500).toLowerCase()
  if (
    header.includes("@generated") ||
    header.includes("do not edit") ||
    header.includes("auto-generated") ||
    header.includes("autogenerated")
  ) {
    return "generated code"
  }
  if (usesStateMachineLib) {
    return "already uses a state-machine library"
  }
  return null
}

/**
 * Runs a read-only single-file state-pressure analysis over `source`.
 *
 * The analyzer parses the source with the TypeScript compiler API and scores
 * overlapping signals (discriminated unions, repeated transitions, event
 * protocols, state-dependent effects, boolean flags, persistence, and
 * transition spread). It returns a deterministic {@link StatePressureResult}
 * with evidence-backed signals and, when warranted, an advisory
 * `@typeonce/effect-machine` recommendation.
 *
 * @since 0.0.0
 */
export const analyzeStatePressure = (
  args: { file: string; source: string }
): StatePressureResult => {
  const { file, source } = args
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const unions: Array<NamedObs> = []
  const enums: Array<NamedObs> = []
  const eventTypes: Array<NamedObs> = []
  const reducerFns: Array<NamedObs> = []
  const effectCalls: Array<NamedObs & { fn: string | null }> = []
  const persistence: Array<NamedObs> = []
  const flagObs: Array<NamedObs> = []
  const flagNames = new Set<string>()
  const transitions: Array<TransitionObs> = []
  const transitionFunctions = new Set<string>()
  const switchFunctionObs: Array<NamedObs> = []
  const switchFunctionNames = new Set<string>()
  let usesStateMachineLib = false

  let currentFunction: string | null = null

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const snippetOf = (node: ts.Node): string => {
    const text = node.getText(sf).replace(/\s+/g, " ").trim()
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  }

  const visit = (node: ts.Node): void => {
    const prevFn = currentFunction
    const fnName = functionNameOf(node, sf)
    if (fnName !== null) {
      currentFunction = fnName
      if (REDUCER_NAMES.has(fnName.toLowerCase())) {
        reducerFns.push({ name: fnName, line: lineOf(node), snippet: snippetOf(node) })
      }
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text
      const lower = name.toLowerCase()
      if (ts.isUnionTypeNode(node.type)) {
        if (DISCRIMINATOR_NAMES.has(lower)) {
          unions.push({ name, line: lineOf(node), snippet: snippetOf(node) })
        }
        if (EVENT_NAMES.has(lower)) {
          eventTypes.push({ name, line: lineOf(node), snippet: snippetOf(node) })
        }
        if (hasDiscriminant(node.type)) {
          unions.push({ name, line: lineOf(node), snippet: snippetOf(node) })
        }
      }
    }

    if (ts.isEnumDeclaration(node) && DISCRIMINATOR_NAMES.has(node.name.text.toLowerCase())) {
      enums.push({ name: node.name.text, line: lineOf(node), snippet: snippetOf(node) })
    }

    if (ts.isSwitchStatement(node)) {
      const base = switchBase(node.expression)
      if (base !== null) {
        transitions.push({
          base,
          line: lineOf(node),
          snippet: snippetOf(node),
          fn: currentFunction
        })
        if (currentFunction !== null) {
          transitionFunctions.add(currentFunction)
          if (!switchFunctionNames.has(currentFunction)) {
            switchFunctionNames.add(currentFunction)
            switchFunctionObs.push({
              name: currentFunction,
              line: lineOf(node),
              snippet: snippetOf(node)
            })
          }
        }
      }
    }

    if (ts.isIfStatement(node)) {
      const base = conditionalBase(node.expression)
      if (base !== null) {
        transitions.push({
          base,
          line: lineOf(node),
          snippet: snippetOf(node),
          fn: currentFunction
        })
        if (currentFunction !== null) {
          transitionFunctions.add(currentFunction)
        }
      }
    }

    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (ts.isStringLiteral(spec) && STATE_MACHINE_LIBS.some((lib) => spec.text.includes(lib))) {
        usesStateMachineLib = true
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0]
      if (ts.isStringLiteral(arg) && STATE_MACHINE_LIBS.some((lib) => arg.text.includes(lib))) {
        usesStateMachineLib = true
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeText = callee.getText(sf)
      if (EFFECT_CALL_PATTERNS.some((p) => calleeText.includes(p))) {
        effectCalls.push({
          name: calleeText,
          line: lineOf(node),
          snippet: snippetOf(node),
          fn: currentFunction
        })
      }
      // Persistence is detected on call/property sites only (e.g.
      // `localStorage.setItem`, `writeFile`, `Effect.persist`), never on a
      // bare identifier such as a local named `snapshot`.
      const isPropAccess = ts.isPropertyAccessExpression(callee)
      const isPersistenceFn = ts.isIdentifier(callee) && PERSISTENCE_FN_NAMES.has(callee.text)
      if (
        (isPropAccess || isPersistenceFn) &&
        PERSISTENCE_PATTERNS.some((p) => calleeText.toLowerCase().includes(p.toLowerCase()))
      ) {
        persistence.push({ name: calleeText, line: lineOf(node), snippet: snippetOf(node) })
      }
    }

    if (
      ts.isPropertySignature(node) && node.type && node.type.kind === ts.SyntaxKind.BooleanKeyword
    ) {
      const name = node.name.getText(sf)
      if (FLAG_PATTERN.test(name) && !flagNames.has(name)) {
        flagNames.add(name)
        flagObs.push({ name, line: lineOf(node), snippet: snippetOf(node) })
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.type.kind === ts.SyntaxKind.BooleanKeyword &&
      ts.isIdentifier(node.name)
    ) {
      const name = node.name.text
      if (FLAG_PATTERN.test(name) && !flagNames.has(name)) {
        flagNames.add(name)
        flagObs.push({ name, line: lineOf(node), snippet: snippetOf(node) })
      }
    }

    ts.forEachChild(node, visit)
    currentFunction = prevFn
  }

  visit(sf)

  const signals: Array<StatePressureSignal> = []

  if (unions.length > 0 || enums.length > 0) {
    const obs = unions.length > 0 ? unions[0] : enums[0]
    signals.push(
      new StatePressureSignal({
        kind: "discriminated-union",
        name: obs.name,
        count: unions.length + enums.length,
        location: Option.some(`${file}:${obs.line}`),
        snippet: Option.some(obs.snippet)
      })
    )
  }

  const byBase = new Map<string, Array<TransitionObs>>()
  for (const t of transitions) {
    const list = byBase.get(t.base) ?? []
    list.push(t)
    byBase.set(t.base, list)
  }
  const repeated = [...byBase.entries()].filter(([, list]) => list.length >= 2)
  if (repeated.length > 0) {
    repeated.sort((a, b) => b[1].length - a[1].length)
    const [base, list] = repeated[0]
    signals.push(
      new StatePressureSignal({
        kind: "repeated-switch",
        name: base,
        count: list.length,
        location: Option.some(`${file}:${list[0].line}`),
        snippet: Option.some(list[0].snippet)
      })
    )
  }

  if (eventTypes.length > 0 || reducerFns.length > 0) {
    const obs = eventTypes.length > 0 ? eventTypes[0] : reducerFns[0]
    signals.push(
      new StatePressureSignal({
        kind: "event-protocol",
        name: obs.name,
        count: eventTypes.length + reducerFns.length,
        location: Option.some(`${file}:${obs.line}`),
        snippet: Option.some(obs.snippet)
      })
    )
  }

  // Effects are only counted when they occur inside a function that also
  // transitions over a discriminator, so a stray `Effect.retry` in a small
  // status/handle function does not trigger the signal.
  const transitionEffects = effectCalls.filter((e) =>
    e.fn !== null && transitionFunctions.has(e.fn)
  )
  if (transitionEffects.length > 0) {
    const distinct = new Set(transitionEffects.map((e) => e.name))
    signals.push(
      new StatePressureSignal({
        kind: "state-dependent-effect",
        name: transitionEffects[0].name,
        count: distinct.size,
        location: Option.some(`${file}:${transitionEffects[0].line}`),
        snippet: Option.some(transitionEffects[0].snippet)
      })
    )
  }

  if (flagObs.length >= 2) {
    signals.push(
      new StatePressureSignal({
        kind: "boolean-flags",
        name: flagObs.map((f) => f.name).join(", "),
        count: flagObs.length,
        location: Option.some(`${file}:${flagObs[0].line}`),
        snippet: Option.some(flagObs[0].snippet)
      })
    )
  }

  if (persistence.length > 0) {
    const distinct = new Set(persistence.map((p) => p.name))
    signals.push(
      new StatePressureSignal({
        kind: "persistence",
        name: persistence[0].name,
        count: distinct.size,
        location: Option.some(`${file}:${persistence[0].line}`),
        snippet: Option.some(persistence[0].snippet)
      })
    )
  }

  if (switchFunctionObs.length >= 2) {
    signals.push(
      new StatePressureSignal({
        kind: "transition-spread",
        name: switchFunctionObs.map((f) => f.name).join(", "),
        count: switchFunctionObs.length,
        location: Option.some(`${file}:${switchFunctionObs[0].line}`),
        snippet: Option.some(switchFunctionObs[0].snippet)
      })
    )
  }

  const score = round2(signals.reduce((acc, s) => acc + (SIGNAL_WEIGHTS[s.kind] ?? 0), 0))
  const confidence = round2(Math.min(1, score / 6))
  const suppressionReason = suppressionOf(file, source, usesStateMachineLib)
  const suppressed = suppressionReason !== null
  const recommendation = !suppressed && score >= RECOMMEND_SCORE &&
    signals.length >= RECOMMEND_KINDS

  const kinds = signals.map((s) => s.kind)
  const mapping: Array<string> = []
  if (kinds.includes("discriminated-union")) {
    mapping.push("states")
  }
  if (kinds.includes("event-protocol")) {
    mapping.push("public events")
  }
  if (kinds.includes("state-dependent-effect")) {
    mapping.push("invokes")
  }
  if (kinds.includes("persistence")) {
    mapping.push("snapshots")
  }
  const message = recommendation
    ? Option.some(
      `This workflow shows ${signals.length} state-pressure signal(s) (${
        kinds.join(", ")
      }) with score ${score}. Consider \`@typeonce/effect-machine\`: map ${
        mapping.length > 0 ? mapping.join(", ") : "the detected concepts"
      } to machine concepts.`
    )
    : Option.none()

  const facts = signals.map((s) =>
    makeAnalysisFact({
      kind: "state-pressure",
      key: s.kind,
      value: `${s.name} (${s.count})`,
      evidence: makeEvidence({
        source: file,
        location: Option.getOrNull(s.location) ?? null,
        snippet: Option.getOrNull(s.snippet) ?? null
      })
    })
  )

  return new StatePressureResult({
    file,
    signals,
    score,
    confidence,
    recommendation,
    message,
    suppressed,
    suppressionReason: Option.fromNullishOr(suppressionReason),
    facts
  })
}

/**
 * Builds the advisory `@typeonce/effect-machine` {@link DesignAdvice} for a
 * {@link StatePressureResult} that recommends a machine. Returns `none` when
 * the result does not recommend.
 *
 * The advice is `lens-advisory` (never a strict `lens-strict` rule) and is
 * distinct from upstream Effect guidance. Applicability is `true` because the
 * recommendation concerns the workflow, not an Effect version window; the
 * version status is `unknown` because effect-machine has no Effect version
 * applicability window.
 *
 * @since 0.0.0
 */
export const statePressureAdvice = (result: StatePressureResult): Option.Option<DesignAdvice> => {
  if (!result.recommendation) {
    return Option.none()
  }
  const evidence = result.signals.map((s) =>
    makeEvidence({
      source: result.file,
      location: Option.getOrNull(s.location) ?? null,
      snippet: Option.getOrNull(s.snippet) ?? null
    })
  )
  const guidance = makeGuidance({
    id: "effect-machine",
    topic: "State Machine",
    summary: "Consider `@typeonce/effect-machine` for this stateful workflow.",
    source: "lens-advisory",
    validationStatus: "unvalidated",
    evidence
  })
  return Option.some(
    new DesignAdvice({
      guidance,
      confidence: result.confidence,
      applicable: true,
      versionStatus: "unknown"
    })
  )
}

/**
 * Runs `design` with the state-pressure facts merged in and, when the analysis
 * recommends a machine, prepends the advisory `@typeonce/effect-machine`
 * {@link DesignAdvice} to the ranked advice.
 *
 * This is the integration seam between the state-pressure analyzer and the
 * existing `design` operation: the analyzer's facts flow into `design` for
 * generic guidance matching, and a qualifying case surfaces explicit advisory
 * guidance for `@typeonce/effect-machine`.
 *
 * @since 0.0.0
 */
export const designWithStatePressure = (args: {
  request: DesignRequest
  result: StatePressureResult
}): DesignResult => {
  const base = design({
    request: {
      ...args.request,
      facts: [...args.request.facts, ...args.result.facts]
    }
  })
  const extra = statePressureAdvice(args.result)
  const advice = Option.isSome(extra) ? [extra.value, ...base.advice] : base.advice
  return new DesignResult({
    feature: base.feature,
    effectVersion: base.effectVersion,
    advice,
    diagnostics: base.diagnostics
  })
}

export { AnalysisFact, DesignAdvice, DesignRequest, DesignResult }
export type { Evidence } from "../Provenance.ts"
