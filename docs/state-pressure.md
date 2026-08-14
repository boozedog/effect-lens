# State-pressure analysis (issue #10)

This document describes the initial state-pressure heuristic, how it integrates
with the `design` surface, and its known limitations.

## Purpose

`effect_lens_design` should detect when an Effect codebase is developing enough
stateful workflow complexity to benefit from `@typeonce/effect-machine`. This is
**architectural, advisory guidance** — never a strict `lens-strict` rule, never
an error or warning from the strict rule catalog, and never an automatic
migration or code generation.

## Where it lives

- `src/operations/statePressure.ts` — the analyzer, its result model, and the
  `design` integration seam.
- `src/operations/design.ts` — the existing `design` operation. It is unchanged;
  the analyzer emits `AnalysisFact` values (kind `state-pressure`) that flow
  into `design`, and `designWithStatePressure` prepends an advisory
  `@typeonce/effect-machine` `DesignAdvice` when the analysis recommends one.
- `src/Provenance.ts` — `SourceKind` gained the additive value `lens-advisory`
  so advisory design recommendations are distinct from both upstream Effect
  guidance and strict `lens-strict` rules.

## Signals

The analyzer is a single-file, AST/type-aware heuristic built on the TypeScript
compiler API. It detects and scores combinations of:

| Signal                   | What it detects                                                                                                              | Weight |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| `discriminated-union`    | `State`/`Status`/`Phase`/`Mode` unions or enums, or any union with a literal discriminant (name-independent)                 | 1.0    |
| `repeated-switch`        | two or more `switch`/`if` transitions over the same discriminator base                                                       | 1.0    |
| `event-protocol`         | `Event`/`Command`/`Action`/`Message`/`Msg` unions, or reducer/transition functions (declarations and const arrows)           | 1.0    |
| `state-dependent-effect` | `Effect.retry`, `Effect.sleep`, `Effect.fork`, `Effect.repeat`, `Effect.schedule`, `Effect.timeout`, `Queue.*`, timers, etc. | 1.0    |
| `boolean-flags`          | two or more boolean flags (`is*`, `has*`, `*Enabled`, `*Active`, …)                                                          | 0.8    |
| `persistence`            | `localStorage`/`sessionStorage`/`Effect.persist`/`Persist.*`/`writeFile`/`readFile` call or property sites                   | 1.0    |
| `transition-spread`      | transitions spread across two or more functions                                                                              | 0.8    |

The **score** is the sum of the weights of the present signals. The
**confidence** is `min(1, score / 6)` rounded to two decimals. Both are
deterministic.

Two refinements keep the heuristic conservative:

- **Effects count only inside transitions.** A `state-dependent-effect` signal
  is emitted only for effect calls that occur inside a function that also
  transitions over a discriminator. Ubiquitous constructors (`Effect.gen`,
  `Effect.suspend`, `Effect.scoped`, `Effect.merge`) are excluded entirely, so
  a small status/handle workflow with a stray `Effect.retry` does not
  recommend.
- **Persistence is detected on call/property sites only.** A bare identifier
  such as a local named `snapshot` or a function named `persistState` does not
  count; only actual storage calls (`localStorage.setItem`, `writeFile`, …)
  do.

## Recommendation rule

A recommendation for `@typeonce/effect-machine` is offered only when **all** of
these hold:

- the file is not suppressed (see below);
- `score >= 3.0`;
- at least **two distinct signal kinds** are present.

A single union or a single switch therefore never produces a recommendation.
The recommendation is emitted as a `lens-advisory` `DesignAdvice` with the
analyzer's confidence, plus a human-readable message listing the signals,
score, and a one-line mapping from detected concepts to machine concepts
(states, public events, invokes, snapshots).

## Suppression

A recommendation is suppressed (never offered) for:

- **generated code** — a `@generated`/`do not edit`/`auto-generated` header,
  or a `.gen.`/`generated` path;
- **tests** — a `.test.`/`.spec.`/`__tests__`/`test/`/`spec/` path;
- **already-modeled code** — an import or `require` of a known state-machine
  library (`@typeonce/effect-machine`, `xstate`, `@xstate`, `robot3`, `stately`,
  `@state-adapt`, `@zag-js/machine`, `@statelyai`).

State-machine usage is detected from **import/require declarations only**, not
from comments or arbitrary source text, so a comment that merely mentions a
library does not suppress a recommendation. Dynamic `import("xstate")` is not
yet detected (only static `import` and `require`).

## Result model

`analyzeStatePressure({ file, source })` returns a `StatePressureResult`:

- `file` — the analyzed path;
- `signals` — `StatePressureSignal` values with `kind`, `name`, `count`,
  `location` (`file:line`), and `snippet`;
- `score`, `confidence` — deterministic numbers;
- `recommendation` — whether to recommend a machine;
- `message` — the advisory message when recommending;
- `suppressed`, `suppressionReason` — suppression state;
- `facts` — `AnalysisFact` values (kind `state-pressure`) with evidence, ready
  to flow into `design`.

`statePressureAdvice(result)` builds the `@typeonce/effect-machine`
`DesignAdvice` (or `none`). `designWithStatePressure({ request, result })`
merges the facts into `design` and prepends the effect-machine advice when
recommended. The advice is a deliberate non-version-gated exception: it carries
`applicable: true` and `versionStatus: "unknown"` because it concerns the
workflow, not an Effect version window (see `docs/contracts.md`).

## Limitations

- **Single-file scope.** Cross-file transition aggregation is a later slice.
  `transition-spread` currently counts functions within one file only.
- **Conditional transitions** are detected as `switch` statements and `if`
  comparisons over a shared discriminator base; more complex transition logic
  (e.g. lookup tables, dynamic dispatch) is not yet recognized.
- **Heuristic, not proof.** The signal list and weights are a starting point and
  will be tuned against real codebases. A recommendation is advisory and must
  not be treated as authoritative.
- **No migration.** The analyzer never rewrites code or generates a machine.
