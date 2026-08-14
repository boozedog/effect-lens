# Self-dogfood check (issue #7)

Effect Lens checks Effect Lens itself. The `dogfood` command runs the real CLI
against this repository's production source and asserts the expected outcomes,
so the tool's own health is verified in a reproducible, read-only project
check.

## Running

```sh
pnpm dogfood
```

This runs five self-checks against the repository root, each via the real CLI
process (`src/cli/index.ts`) in `--json` mode:

1. `doctor` — asserts the resolved Effect identity matches the version declared
   in `package.json` and that the reference pack is `complete`.
2. `drift` — asserts the local dependency and reference-pack state is
   all-`compatible`.
3. `check --path src` — asserts zero Lens findings on the production source
   and that at least one file was actually linted.
4. `setup --dry-run` — asserts a well-formed, read-only setup plan (oxlint
   configured, a `hooks` step present) and that no inspected config or hook
   file changed.
5. `hooks status` — asserts a read-only status report over the known hook
   managers and that no inspected config or hook file changed.

The command exits `0` when every self-check passes and `1` otherwise, printing
a per-check summary that names the failing check and the assertion that broke.

The `setup` and `hooks` self-checks snapshot the config and hook files they
inspect (`package.json`, `.oxlintrc.json`, `.oxlintrc`, `lefthook.yml`,
`lefthook.yaml`, `.pre-commit-config.yaml`, `.pre-commit-config.yml`, and any
`.husky/**` files) before and after running, and assert they are unchanged, so
the read-only guarantee is proven against the real CLI.

`pnpm dogfood` is part of the canonical validation path: `pnpm verify` runs it
after lint, format, typecheck, and tests, and `pnpm release:check` (the release
self-review gate) runs the full `pnpm verify` path. See `docs/ci.md`.

## Bootstrap boundary

This slice is a development-time self-check, not a packaged artifact. It
depends on:

- The checked-out TypeScript source (`src/cli/index.ts`), run with Node's
  native type stripping.
- The local dependencies installed in `node_modules` (for oxlint and the
  Effect runtime).
- The committed reference-pack fixture cache under `test/fixtures/cache`
  (specifically `pack-effect-109`, which matches the pinned Effect version).

It does **not** rely on the developer's home cache (`~/.cache/effect-lens`) or
on a `../effect` checkout. The check is strictly read-only: it never mutates
source, config, packs, or hooks.

## Exact-pin requirement

The `doctor` self-check asserts that the resolved Effect identity equals the
`effect` specifier declared in `package.json`. This comparison only holds while
that specifier is an exact pin (e.g. `4.0.0-rc.109`). A range specifier (e.g.
`^4.0.0`) would false-fail a healthy repo, because the lockfile-resolved
version is exact. Keep the `effect` specifier an exact pin for this self-check.

## Fixture/cache dependency

The self-check uses the committed fixture cache rather than a live or
developer-local cache so it is reproducible from a clean checkout. When the
pinned Effect version changes, the matching fixture pack must be added to
`test/fixtures/cache` and the expected version assertion follows automatically
from `package.json`.

The committed cache is validated by `pnpm policy` (see `docs/ci.md`): every
production pack manifest must decode, declare `complete`, and have every
included file present on disk.

## Future work

- **Waiver enforcement in the CLI** — `pnpm policy` validates the committed
  `waivers.json` (schema and scope/path consistency), but the CLI does not yet
  apply waivers to findings. Applying waivers to `check` output is deferred.
- **Live upstream drift** — `drift` remains a local, offline slice; comparing
  against live upstream tooling is deferred.
- **pi exercise** — the pi adapter (issue #6) does not exist yet; pi dogfooding
  is not claimed here. This slice only verifies the CLI against its own source.

CI enforcement, policy/metadata validation, and release checks are now in place;
see `docs/ci.md` for what is enforced and what remains deferred.
