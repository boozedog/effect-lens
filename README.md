# Effect Lens

Effect Lens is an advisory tool for Effect v4 TypeScript development. It ships a
CLI (`effect-lens doctor`, `effect-lens drift`, `effect-lens check`, `effect-lens
setup --dry-run` / `setup --apply`, `effect-lens hooks status` / `install` /
`uninstall`, `effect-lens packs status` / `packs plan` / `packs fetch`,
`effect-lens adoption audit`, and `effect-lens freshness`) that
inspects a project's Effect tooling, reports findings and
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
- `effect-lens packs status` / `packs plan` for read-only reference-pack
  baseline/status and acquisition planning, and `packs fetch` for explicit,
  verified pack acquisition.
- `effect-lens freshness` for a network-backed, read-only recommendation of
  the newest Effect version allowed by the channel and release-age/cooldown
  policy, plus the required reference pack.
- `effect_lens_lookup` for local Effect guidance and source lookup.
- `effect_lens_review` for AST/type-aware code review.
- `effect_lens_design` for Effect-first implementation guidance.

Most commands are read-only; `setup --apply`, `hooks install|uninstall`, and
`packs fetch` are the explicit mutation surfaces and never mutate implicitly.
`freshness` is the only network-backed command (it fetches an explicit registry
snapshot); every other command stays offline.

## Installation

Effect Lens is published as the `effect-lens` npm CLI package. Install it
globally with your package manager of choice:

```sh
npm install -g effect-lens        # or: nub add -g effect-lens
effect-lens --version
```

The CLI requires Node `>=22.6`. It does not require Nub to be installed
globally at runtime. The published package ships compiled JavaScript (see
`docs/packaging.md` for the package metadata, published contents, runtime
dependencies, and release policy).

## CLI

The CLI is a thin adapter over the shared core operations. Run `nub run cli -- --help`
from this repository, or `effect-lens --help` from a checked-out project. See
`docs/cli.md` for details.

### Monorepo workspace resolution

In a pnpm monorepo the lockfile lives at the repository root while Effect may
be declared in a workspace package. Pass `--workspace <pkg>` (relative to
`--project`) to the resolution-based commands (`doctor`, `drift`,
`setup --dry-run`, `packs plan`, `packs status`, `adoption audit`, and `freshness`) to resolve that package's Effect version from
the root lockfile and select the exact reference pack. `check` uses
`--workspace` to scope the lint target (the staged changed files for
`check --changed`, or the workspace's tree for a full `check`), and
`hooks install` / `setup --apply` validate it and pass the canonicalized
importer path into the generated hook command so the installed pre-commit
check lints only the selected workspace's staged files. The target may be the
full importer path (`packages/foldkit`) or the final path segment (`foldkit`);
an ambiguous basename and an unmatched target are reported as blocking errors
for the resolution-based commands, `check` (full-check), `setup --apply`, and
`hooks install`. A full `check` and the hook install paths validate the target
before any lint run or `hk.pkl` write (never a partial write) and canonicalize
a valid basename to the full importer path.
Single-package repositories are unaffected and need no extra flags. See
`docs/cli.md` for the full precedence rules.

## Development

This repository uses **Nub** (pinned `0.7.5`, declared in the `packageManager`
and `devEngines.packageManager` fields of `package.json`) as its exclusive
package manager. Nub reads the committed `pnpm-lock.yaml` directly, so a clean
checkout installs with:

```sh
nub install --frozen-lockfile
```

All scripts are invoked through `nub run` (e.g. `nub run verify`); pnpm is
neither required nor supported. The canonical validation path is
`nub run verify` (see `docs/ci.md`). Packaging is Nub-native too: `nub run
build` compiles `src/` to `dist/`, `nub pack --dry-run` lists the intended
tarball contents, and `nub run pack:check` verifies the packed artifact and a
clean consumer install (see `docs/packaging.md`).

## Self-dogfood

Effect Lens checks Effect Lens itself. Run `nub run dogfood` to verify the real
CLI against this repository's production source, and `nub run policy` to validate
the committed waivers, reference-pack manifests, and guidance metadata. Both are
part of the canonical validation path (`nub run verify`) and the release
self-review gate (`nub run release:check`), and are enforced in CI. See
`docs/dogfood.md` and `docs/ci.md`.

## Shared core

The CLI, pi extension, and future MCP adapter share one set of core data
contracts — project/dependency identity, reference packs, guidance/evidence,
rules/findings, and drift reports. See `docs/contracts.md` for the type and
serialization definitions.

On top of those contracts sit the adapter-independent read-only operations in
`src/operations/`: `lookup` (search ingested guidance with provenance and
version applicability), `review` (normalize oxlint diagnostics through the rule
provider seam into stable findings), and `design` (combine analysis facts with
guidance into advisory advice with confidence). They centralize policy and
analysis logic so no surface adapter duplicates it. See `docs/contracts.md` for
the operation contracts.

`check` is a configurable unified gate foundation. It normalizes toolchain
diagnostics through registered rule providers (`src/provider/`); the Lens
strict rules are the first provider, followed by the Foldstryx and StyleX
first-party providers. `check` runs in two modes: `lens-only`
(default, preserving the existing single-package behavior) and `unified` (a
config-preserving gate that loads the target repository's oxlint config —
ignores, overrides, and rule settings — while loading the Lens rules, and
surfaces unknown project diagnostics with their raw oxlint severity). During migration,
equivalent Lens and Foldstryx diagnostics at the same rule/location collapse
to a single finding, and a read-only migration report recommends the Lens
equivalent for each redundant Foldstryx rule. When the oxlint subprocess fails
to start, produces no JSON, or produces unparseable output (config/plugin
failures), the run is reported as unavailable — never as an empty clean gate —
with the exit status, signal, and a bounded stderr excerpt preserved; a run
with valid JSON diagnostics is a normal gate even when it exits non-zero. See
`docs/cli.md` for the modes, configuration precedence, and migration behavior.

The StyleX provider recognizes the supported official `@stylexjs/eslint-plugin`
rule catalog and keeps StyleX findings with `provider: "stylex"` provenance and
`source: "project"` classification, distinct from Lens strict/upstream guidance.

## Reference-pack acquisition planning

Lens can plan the acquisition of managed reference packs without touching the
network or the cache. `src/PackPlan.ts` exposes `planPackAcquisition`, a
read-only planner that derives the project's exact Effect identity via the
resolver, classifies the local pack state (`already-complete`,
`fetch-required`, `stale-pack-present`, `partial-pack-present`,
`catalog-entry-missing`, `resolution-unavailable`), and returns an ordered,
JSON-serializable plan. It performs only the resolver/verifier's read-only
filesystem reads and never writes anything. The catalog input is explicit —
callers pass the entries directly or load them with `loadPackCatalog` — and a
catalog entry is selected only by exact name+version match, never by range or
"any newer" selection.

Planning is strictly read-only: it never fetches, writes, deletes, or updates
cache files, and it never adds implicit network behavior to `doctor`, `drift`,
`lookup`, or guidance ingestion. The explicit acquisition executor
`src/PackAcquire.ts` (`acquirePack`) verifies and atomically promotes a chosen
pack through an injected, synchronous transport; it is never invoked implicitly
and performs no network I/O itself.

The `packs` CLI surface exposes this explicitly:

```sh
effect-lens packs status --project . --cache <dir> --catalog <dir> --json
effect-lens packs plan --project . --cache <dir> --catalog <dir> --json
effect-lens packs fetch --project . --cache <dir> --catalog <dir> --id <pack-id> --json
```

`packs status` and `packs plan` are read-only. `packs status` reports whether
the project's exact Effect pack is `unresolved`, `absent`, `stale`, `corrupt`,
`complete`, `mismatched`, or `verified` against an explicit catalog baseline,
plus the same-name candidate baselines the catalog offers (read-only
availability for the freshness recommendation, issue #15). `packs fetch`
is the only command that invokes a
transport: it requires an explicit `--catalog` and an exact `--id`, stages the
artifact via the local-directory transport (`src/PackTransport.ts`), and hands
it to `acquirePack`, which verifies identity, version, integrity, path-traversal
and symlink safety, and content completeness before atomically promoting the
pack into the cache. The supported artifact format for this slice is a single
local directory (the catalog entry's `sourceUrl` points at a directory
containing the included files plus a `manifest.json`); no remote or archive
format is supported yet. An existing complete pack is a safe no-op; `--replace`
is only needed to recover a divergent cached pack. See `docs/cli.md` and
`docs/contracts.md` for the
command usage, artifact format, offline boundary, and cache-mutation behavior.

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
