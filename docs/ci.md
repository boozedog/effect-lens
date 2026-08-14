# CI, policy, and release checks (issue #7)

Effect Lens continuously checks itself. A GitHub Actions workflow
(`.github/workflows/ci.yml`) installs the pinned pnpm/Node toolchain and runs
the canonical validation path on every push to `master`, every pull request,
and every `v*` tag. The same path is available locally as `pnpm verify` and
`pnpm release:check`.

## Canonical validation path

`pnpm verify` runs, in order:

1. `pnpm lint` — oxlint over the repository.
2. `pnpm format:check` — dprint formatting check.
3. `pnpm check` — TypeScript typecheck.
4. `pnpm test` — the vitest suite.
5. `pnpm dogfood` — the self-dogfood check (see `docs/dogfood.md`).
6. `pnpm policy` — the policy/metadata validation described below.

`pnpm release:check` is an alias for `pnpm verify`; it is the release
self-review gate and is run by the `release` CI job on `v*` tags.

## CI workflow

The workflow has two jobs:

- **`verify`** — runs on pushes to `master`, on pull requests, and on `v*`
  tags. Installs with the pinned toolchain and runs `pnpm verify`. On a tag
  push it runs in parallel with the `release` job (both run `pnpm verify`);
  this is redundant but harmless.
- **`release`** — runs only on `v*` tags. Installs with the pinned toolchain and
  runs `pnpm release:check` (the same production-source checks) before release.

Both jobs use the same pinned toolchain:

- pnpm `11.20.0` (matching the `packageManager` field) via `pnpm/action-setup`.
- Node `22` (the `engines` floor) via `actions/setup-node`, with the pnpm store
  cached.
- `pnpm install --frozen-lockfile` for a reproducible dependency install.

The checks are read-only with respect to project source, packs, and
configuration. They require no network access beyond the dependency install
performed by CI setup: the dogfood and policy checks use only the checked-out
source and the committed fixture cache.

## Policy/metadata validation (`pnpm policy`)

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

- A failing `pnpm verify` step fails the CI job. The per-check summary names the
  failing check and the assertion that broke, so a failure is actionable.
- A missing or invalid `waivers.json`, a broken pack manifest, a missing
  included file, or malformed/conflicting guidance all fail `pnpm policy` with
  exit `1`.
- The dogfood check fails with exit `1` when doctor, drift, or check do not
  match the expected outcomes (see `docs/dogfood.md`).

## What is enforced now vs deferred

Enforced by CI:

- The strict Lens rules run against production `src` (via `pnpm dogfood` and
  `pnpm lint`), separately from the intentional rule fixtures.
- Waivers are validated (schema + scope/path consistency) and must be committed.
- Reference-pack manifests and guidance metadata are validated.
- The release path runs the same production-source checks before release.

Deferred (reported explicitly by `pnpm policy` and documented here):

- **Waiver application in the CLI** — `pnpm policy` validates waivers, but the
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
