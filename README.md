# Effect Lens

Effect Lens is an advisory tool for Effect v4 TypeScript development. It ships a
CLI (`effect-lens doctor`, `effect-lens drift`, `effect-lens check`, `effect-lens
setup --dry-run` / `setup --apply`, `effect-lens hooks status` / `install` /
`uninstall`) that inspects a project's Effect tooling, reports findings and
diagnostics with stable human-readable and machine-readable output and stable
exit codes, and sets up the `hk` hook-manager check explicitly. See
`docs/cli.md` for the command reference, read-only/mutation behavior, and
current limitations.

It will combine the local Effect guidance in `../effect/LLMS.md` with TypeScript AST and type analysis to help agents design, review, and improve Effect code. Findings are evidence-backed suggestions, not authoritative rewrites.

Planned surfaces:

- `effect-lens doctor` / `drift` / `check` for local tooling inspection.
- `effect-lens setup --dry-run` for read-only setup planning and `setup --apply`
  for the explicit mutating hooks install.
- `effect-lens hooks status` / `install` / `uninstall` for hook-manager
  inspection and explicit `hk` hook mutation.
- `effect_lens_lookup` for local Effect guidance and source lookup.
- `effect_lens_review` for AST/type-aware code review.
- `effect_lens_design` for Effect-first implementation guidance.

Most commands are read-only; `setup --apply` and `hooks install|uninstall` are
the explicit mutation surfaces and never mutate implicitly.

## CLI

The CLI is a thin adapter over the shared core operations. Run `pnpm cli -- --help`
from this repository, or `effect-lens --help` from a checked-out project. See
`docs/cli.md` for details.

## Self-dogfood

Effect Lens checks Effect Lens itself. Run `pnpm dogfood` to verify the real
CLI against this repository's production source, and `pnpm policy` to validate
the committed waivers, reference-pack manifests, and guidance metadata. Both are
part of the canonical validation path (`pnpm verify`) and the release
self-review gate (`pnpm release:check`), and are enforced in CI. See
`docs/dogfood.md` and `docs/ci.md`.

## Shared core

The CLI, pi extension, and future MCP adapter share one set of core data
contracts — project/dependency identity, reference packs, guidance/evidence,
rules/findings, and drift reports. See `docs/contracts.md` for the type and
serialization definitions.

On top of those contracts sit the adapter-independent read-only operations in
`src/operations/`: `lookup` (search ingested guidance with provenance and
version applicability), `review` (map oxlint diagnostics to stable findings),
and `design` (combine analysis facts with guidance into advisory advice with
confidence). They centralize policy and analysis logic so no surface adapter
duplicates it. See `docs/contracts.md` for the operation contracts.

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
