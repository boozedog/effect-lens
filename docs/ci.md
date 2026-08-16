# CI, policy, and release checks (issue #7)

Effect Lens continuously checks itself. A GitHub Actions workflow
(`.github/workflows/ci.yml`) installs the pinned Nub/Node toolchain and runs
the canonical validation path on every push to `master`, every pull request,
and every `v*` tag. The same path is available locally as `nub run verify` and
`nub run release:check`.

## Canonical validation path

`nub run verify` runs, in order:

1. `nub run pm-guard` — the package-manager guard (issue #11) rejects any
   accidental active pnpm tool reference across `package.json`, CI workflows,
   docs, and scripts.
2. `nub run lint` — oxlint over the repository.
3. `nub run format:check` — dprint formatting check.
4. `nub run check` — TypeScript typecheck.
5. `nub run test` — the vitest suite.
6. `nub run dogfood` — the self-dogfood check (see `docs/dogfood.md`).
7. `nub run policy` — the policy/metadata validation described below.
8. `nub run pack:check` — the package publication check (see
   `docs/packaging.md`): it asserts the packed tarball contents, then installs
   the tarball into a clean consumer fixture with Nub and runs the CLI there to
   prove the published artifact is self-contained and runnable without a source
   checkout or a globally installed Nub at runtime. It never publishes.

`nub run release:check` is an alias for `nub run verify`; it is the release
self-review gate and is run by the `release` CI job on `v*` tags.

## CI workflow

The workflow has two jobs:

- **`verify`** — runs on pushes to `master`, on pull requests, and on `v*`
  tags. Installs with the pinned toolchain and runs `nub run verify`. On a tag
  push it runs in parallel with the `release` job (both run `nub run verify`);
  this is redundant but harmless.
- **`release`** — runs only on `v*` tags. Installs with the pinned toolchain and
  runs `nub run release:check` (the same production-source checks) before release.

Both jobs use the same pinned toolchain:

- Nub `0.7.5` (matching the `packageManager` / `devEngines.packageManager`
  fields), fetched from the official Nub GitHub release and verified against a
  pinned SHA-256 before being added to `PATH`.
- Node `22` (the `engines` floor) via `actions/setup-node`.
- The Nub content-addressed store (`~/.local/share/nub/store/v1`) is cached,
  keyed on the committed `pnpm-lock.yaml`.
- `nub install --frozen-lockfile` for a reproducible dependency install (Nub
  reads the committed `pnpm-lock.yaml` directly).

### Aube virtual-store layout

Nub's package engine (Aube) links dependencies through a per-project virtual
store. The project pins `enableGlobalVirtualStore=true` in `.npmrc` (the Aube
"global-virtual-store" linker), so the layout is explicit and reproducible
across Nub versions: top-level packages are symlinks into
`node_modules/.store/<pkg>/node_modules/<pkg>` (an `isolated` nodeLinker
layout, like pnpm's virtual store but owned by Nub), and each `.store/<pkg>`
entry is itself a symlink into Nub's per-user pm store
(`~/.cache/nub/pm/store/`). `node_modules` is gitignored, so a clean checkout
always re-links it with `nub install --frozen-lockfile`. CI caches the
content-addressed store (`~/.local/share/nub/store/v1`) so installs avoid
re-downloading tarballs.

The checks are read-only with respect to project source, packs, and
configuration. They require no network access beyond the dependency install
performed by CI setup: the dogfood and policy checks use only the checked-out
source and the committed fixture cache. The `pack:check` step's clean consumer
fixture `nub install` may resolve the runtime dependencies (`effect`, `oxlint`,
`typescript`) from the registry if they are not already in the Nub store.

## Policy/metadata validation (`nub run policy`)

`scripts/policy.mjs` deterministically validates the committed policy and
reference metadata that the self-dogfood check relies on. It reuses the shared
Schema contracts from `src/` rather than reimplementing policy. It runs three
checks:

1. **waivers** — the committed `waivers.json` must be a JSON array whose
   entries decode against the `Waiver` schema and are scope/path consistent
   (`global` has no path; `path`/`file` require one). Expired waivers are
   reported but do not fail the check.
2. **packs** — every production reference-pack manifest under
   `test/fixtures/cache` must decode against the `PackManifest` schema, declare
   `complete`, and have every included file present on disk.
3. **guidance** — ingesting each production pack must produce no `warning` or
   `error` diagnostics (malformed or conflicting guidance). `info` diagnostics
   (e.g. a title-only file with no guidance blocks) are notes, not violations.

The command exits `0` when every check passes and `1` otherwise, printing a
per-check summary that names the failing check and the assertion that broke.

### Bootstrap boundary and fixture/cache assumptions

- The policy check targets the **production** cache (`test/fixtures/cache`)
  only. The intentional test fixtures under `test/fixtures/cache-partial`,
  `test/fixtures/cache-stale`, and `test/fixtures/ingest` exercise the
  `partial`/`stale`/malformed/conflict paths in the test suite and are kept
  outside the production self-check targets.
- The committed `waivers.json` is the single source of truth for waivers. Any
  waiver added to the repository must be committed there and must be valid;
  CI rejects an invalid committed `waivers.json`. Note that the success test
  currently pins `waivers.count === 0`, so adding a waiver fails that test
  until the assertion is updated to the new count.
- The committed cache is the reproducible source for the dogfood and policy
  checks. It does not depend on the developer's home cache or a `../effect`
  checkout.

### Failure behavior

- A failing `nub run verify` step fails the CI job. The per-check summary names the
  failing check and the assertion that broke, so a failure is actionable.
- A missing or invalid `waivers.json`, a broken pack manifest, a missing
  included file, or malformed/conflicting guidance all fail `nub run policy` with
  exit `1`.
- The dogfood check fails with exit `1` when doctor, drift, or check do not
  match the expected outcomes (see `docs/dogfood.md`).
- The package-manager guard fails with exit `1` when an active project/CI/docs
  file references pnpm as a required tool (see
  `scripts/package-manager-guard.mjs`).

## Package publication check (`nub run pack:check`)

`scripts/package-check.mjs` verifies the packed `effect-lens` artifact without
publishing. It builds `dist/`, runs `nub pack --dry-run --json` to assert the
intended contents (the CLI bin, the compiled runtime modules, `package.json`,
and `README.md`) and the exclusion of development artifacts (`test/`, `docs/`,
`scripts/`, `.github/`, `src/`, lockfiles, caches, and configs), then runs
`nub pack` to a temporary directory, installs the tarball into a clean consumer
fixture with `nub install`, and runs the CLI there (`--version`, `--help`, a
read-only `doctor`, and the default `check` over a fixture that contains a
known Lens violation and a real `node_modules`, asserting the finding is
reported, oxlint starts without `ENOBUFS`, and only fixture sources are
linted). It exits `0` when every check passes and `1` otherwise. See
`docs/packaging.md` for the full package metadata and release policy.

## What is enforced now vs deferred

Enforced by CI:

- Nub is the exclusive package manager: the package-manager guard rejects
  active pnpm tool references, and CI installs, caches, and runs scripts with
  Nub only.
- The strict Lens rules run against production `src` (via `nub run dogfood` and
  `nub run lint`), separately from the intentional rule fixtures.
- Waivers are validated (schema + scope/path consistency) and must be committed.
- Reference-pack manifests and guidance metadata are validated.
- The release path runs the same production-source checks before release.

Deferred (reported explicitly by `nub run policy` and documented here):

- **Waiver application in the CLI** — `nub run policy` validates waivers, but the
  CLI does not yet apply waivers to `check` findings.
- **Live upstream drift** — `drift` is a local, offline slice; comparing
  against live upstream tooling is deferred.
- **Remote pack acquisition** — packs are committed fixtures, never fetched.
- **Full semver range semantics** — only numeric-semver prefixes are compared.
- **Semantic contradiction analysis** — conflict detection is a
  same-topic/different-summary heuristic.
- **Waiver expiry enforcement** — expired waivers are reported but do not fail
  the check.
- **pi exercise** — the pi adapter (issue #6) is tracked independently and is
  not required for this issue.
