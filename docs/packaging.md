# Package publication and release (issue #16)

Effect Lens is published as a stable npm CLI package named `effect-lens`. This
document describes the package metadata, the published contents, the runtime
dependencies, the Node requirement, the version/release policy, and the
Nub-native development and verification workflow. This repository never
publishes to a registry from CI or from a script; publication is a deliberate,
human-authorized step.

## Package metadata

The public package metadata lives in `package.json`:

- **name** — `effect-lens`.
- **version** — `0.1.0` (the first stable release). The version is the single
  source of truth for the CLI's `--version` output and the drift report's
  `toolchain.lensVersion`; it is read from `package.json` at runtime
  (`src/cli/version.ts`).
- **license** — `MIT`.
- **repository** — `https://github.com/boozedog/effect-lens.git`.
- **publishConfig.access** — `public` (the package is published to the public
  npm registry; no credentials are stored in this repository).
- **engines.node** — `>=22.6`. The published CLI runs on any supported Node
  without native type stripping, so the floor is the same as the development
  floor.

## Published contents

The `files` field is explicit and minimal:

```json
{ "files": ["bin", "dist", "README.md"] }
```

`package.json` is always included by the packer. The tarball therefore contains:

- `bin/effect-lens.mjs` — the CLI launcher.
- `dist/` — the compiled JavaScript runtime (all CLI commands, operations,
  rule providers, and the oxlint plugin), produced by `nub run build`.
- `README.md` — the package readme.
- `package.json` — the manifest.

Development artifacts are deliberately excluded: `test/`, `docs/`, `scripts/`,
`.github/`, the TypeScript source under `src/`, `tsconfig*.json`,
`vitest.config.ts`, `dprint.json`, `.oxlintrc.json`, `waivers.json`,
`pnpm-lock.yaml`, `.npmrc`, and `*.tsbuildinfo` are never packed. The
`nub run pack:check` step asserts both the required contents and these
exclusions.

## Runtime dependencies

The published CLI declares three runtime dependencies in `dependencies`:

- **`effect`** — the Effect library used by the core operations and schemas.
- **`typescript`** — used by the state-pressure analysis (`src/operations/statePressure.ts`).
- **`oxlint`** — the linter binary the `check` command drives.

`@oxlint/plugins` remains a devDependency: it is imported only as types
(erased at compile time) and is not needed at runtime. The `check` command
resolves the `oxlint` binary by walking up from the package to the nearest
`node_modules/.bin/oxlint`, so it works both from a source checkout and from
the published package installed in an isolated virtual store.

The first-party rule providers (Lens, Foldstryx, and StyleX) ship inside the
package under `dist/provider/`. Reference packs are **not** distributed in the
npm package: they are acquired separately with `effect-lens packs fetch` into a
local cache (see `docs/cli.md`), so adopters should not expect packs inside the
installed package.

The package is CLI-only: it declares a `bin` but no `exports`/`main`, so there
is no public JavaScript API to import. Consumers use the `effect-lens` command
line interface.

## Why the package ships compiled JavaScript

The development CLI runs TypeScript source directly with Node's native type
stripping (`--experimental-strip-types`). Node does **not** apply type
stripping to files under `node_modules`, so a published package cannot ship
`.ts` source. Instead, `nub run build` compiles `src/` to plain JavaScript in
`dist/`, and the published `bin/effect-lens.mjs` launcher runs
`dist/cli/index.js` directly. This keeps the published CLI compatible with the
`>=22.6` Node floor and requires no globally installed Nub at runtime.

## Version pinning and release policy

- The version is bumped manually in `package.json`; the lockfile is
  regenerated with `nub install` when dependencies change.
- Releases are tagged `v<version>` (e.g. `v0.1.0`). The `release` CI job runs
  `nub run release:check` (an alias for `nub run verify`) on `v*` tags as a
  self-review gate before a human publishes.
- Publishing to the npm registry is a human step (`nub publish` or the
  equivalent) and is never performed by CI or by a script in this repository.

### Consumer version pinning and rollback

Consumers pin the exact version they want. With Nub:

```sh
nub add -g effect-lens@0.1.0        # pin a specific version
```

With npm:

```sh
npm install -g effect-lens@0.1.0    # pin a specific version
```

To roll back to a previous release, install the earlier version explicitly
(e.g. `nub add -g effect-lens@0.0.1` or `npm install -g effect-lens@0.0.1`).
Because the CLI is a single global package with no runtime dependency on Nub,
rollback is a simple version swap; there is no state to migrate.

## Nub-native development and verification

All package operations are Nub-native; npm is not used for packaging or
verification.

```sh
nub run build        # compile src/ -> dist/
nub pack --dry-run   # list the intended tarball contents without writing
nub pack             # write the tarball (runs prepack -> build first)
nub run pack:check   # assert contents + clean consumer install + CLI run
nub run verify       # the canonical validation path (includes pack:check)
```

`nub run pack:check` (`scripts/package-check.mjs`) does the following without
publishing:

1. Builds `dist/`.
2. Runs `nub pack --dry-run --json` and asserts the required contents and the
   exclusion of development artifacts.
3. Runs `nub pack --pack-destination <tmp>` to produce the tarball.
4. Creates a clean consumer fixture outside the repository, installs the
   tarball with `nub install`, and runs the CLI there (`--version`, `--help`,
   a read-only `doctor`, and the default `check` over a fixture that contains a
   known Lens violation and a real `node_modules`, asserting the finding is
   reported, oxlint starts without `ENOBUFS`, and only fixture sources are
   linted) to prove the packed artifact is self-contained and runnable without
   a source checkout and without a globally installed Nub at runtime.
5. Creates a **workspace-style consumer** (issue #17) outside the repository,
   installs the tarball with `nub install`, and exercises the real integration
   paths against the packed CLI:
   - **Root lockfile + workspace importer resolution** — `doctor` resolves the
     root importer (`4.0.0-rc.109`) and a selected `--workspace packages/app`
     importer (which pins a distinct `4.0.0-beta.83`) from the consumer's root
     `pnpm-lock.yaml`, so the workspace assertion can only pass if the selected
     importer was actually consulted rather than falling back to the root.
   - **Invalid / ambiguous workspace targets** — a full `check` with an
     unresolved (`nonexistent`) or ambiguous (`app`, matching both
     `packages/app` and `apps/app`) target is rejected with exit `2` and an
     actionable diagnostic.
   - **Consumer config/plugin path** — a full `check --mode unified
     --workspace packages/app` loads the consumer's own `.oxlintrc.json` and a
     deterministic plugin fixture (`fixture/no-console`), reports the Lens
     finding with `(lens)` provider provenance (and `"provider": "lens"` in the
     `--json` payload), and excludes an outside-workspace root violation.
   - **Staged changed-file scope** — `check --mode unified --workspace
     packages/app --changed` lints only the selected workspace's staged files
     (the root staged file is excluded) and honors the consumer config ignores.
   - **Actionable config/plugin failure** — a broken plugin surfaces
     `exit 1` / `Failed to load JS plugin` metadata and a
     `check-oxlint-unavailable` diagnostic, never a clean empty gate.
   - **Hook install** — `hooks install --workspace packages/app` discovers the
     local packed binary and generates an hk command that includes the unified
     changed scope and the selected workspace; the script then extracts the
     written `["effect-lens"]` step's `check` command and spawns it from the
     consumer cwd, asserting it runs the unified changed-scope check.
6. Removes all temporary artifacts in a `finally` block (on both success and
   failure) and verifies they are gone.

## Consumer installation

Consumers install the published package with their package manager of choice:

```sh
npm install -g effect-lens        # or: nub add -g effect-lens
effect-lens --version
```

The CLI requires Node `>=22.6`. It does not require Nub to be installed
globally at runtime.
