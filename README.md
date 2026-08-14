# Effect Lens

Effect Lens is an advisory tool for Effect v4 TypeScript development.

It will combine the local Effect guidance in `../effect/LLMS.md` with TypeScript AST and type analysis to help agents design, review, and improve Effect code. Findings are evidence-backed suggestions, not authoritative rewrites.

Planned surfaces:

- `effect_lens_lookup` for local Effect guidance and source lookup.
- `effect_lens_review` for AST/type-aware code review.
- `effect_lens_design` for Effect-first implementation guidance.

The first implementation will be small, read-only, and Effect-first itself.

## Shared core

The CLI, pi extension, and future MCP adapter share one set of core data
contracts — project/dependency identity, reference packs, guidance/evidence,
rules/findings, and drift reports. See `docs/contracts.md` for the type and
serialization definitions.

## Strict rule layer

Lens ships a strict Effect-first AST rule layer on top of upstream Oxlint
tooling. The rules live in `src/rules/` (the Lens rule catalog) and
`src/plugin/` (the oxlint plugin, loaded via `jsPlugins` in `.oxlintrc.json`).

The initial rules are all `lens-strict` footgun rules:

- `lens/no-async-function` — bans `async` functions.
- `lens/no-await-expression` — bans `await`, except the narrow bind-aware
  `Effect.runPromise` bridge.
- `lens/no-new-promise` — bans manual `Promise` construction, including
  aliased constructors.

Rules use AST and binding information (never text matching) and are
bind-aware: aliases and shadowing are caught where the oxlint scope API
supports it. See `docs/contracts.md` for the rule catalog, plugin, and
evidence/provenance mapping.
