# Effect Lens CLI

The `effect-lens` CLI is a thin adapter over the shared core
operations. It exposes six commands — `doctor`, `drift`, `check`, `setup`,
`hooks`, and `packs` — that
inspect a project's Effect tooling and report findings and diagnostics with
stable human-readable and machine-readable output and stable exit codes.

The CLI never re-implements policy: every command delegates to the shared core
operations in `src/operations/` and the shared contracts in `src/`. It never
mutates project configuration. `doctor`, `drift`, `check`, `setup --dry-run`,
`hooks status`, `packs plan`, and `packs status` are read-only and never fetch
packs or mutate caches; `setup --apply`, `hooks install|uninstall`, and
`packs fetch` are the explicit mutation surfaces.

## Running the CLI

From a checked-out project:

```sh
effect-lens <command> [options]
```

Within this repository, the same entrypoint is available as:

```sh
nub run cli -- <command> [options]
```

The CLI runs the TypeScript entrypoint with Node's native type stripping, so it
requires Node 23.6+ (or Node 22.6+ with `--experimental-strip-types`, which the
`bin/effect-lens.mjs` launcher passes automatically).

## Global options

| Option                | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `-p, --project <dir>` | Project directory to inspect (default: current directory).                                         |
| `--workspace <pkg>`   | Explicit workspace/package target relative to `--project` (monorepos).                             |
| `-c, --cache <dir>`   | Reference-pack cache directory (default: `$XDG_CACHE_HOME/effect-lens` or `~/.cache/effect-lens`). |
| `--catalog <dir>`     | Reference-pack catalog baseline directory (packs status/plan/fetch only).                          |
| `--id <pack-id>`      | Exact catalog entry id to fetch (packs fetch only).                                                |
| `--replace`           | Replace a divergent cached pack (packs fetch only).                                                |
| `-j, --json`          | Emit machine-readable JSON instead of human-readable text.                                         |
| `-h, --help`          | Print usage.                                                                                       |
| `-v, --version`       | Print the version.                                                                                 |

## Workspace target selection and resolution precedence

Effect Lens inspects a single project at a time. In a pnpm monorepo the
lockfile lives at the repository root while Effect may be declared in a
workspace package, so the root importer does not necessarily own Effect. Use
`--workspace` to select the package to resolve:

```sh
effect-lens doctor --project . --workspace packages/foldkit --cache ~/.cache/effect-lens
```

`--project` is always the repository root (the lockfile and configuration
boundary). `--workspace` selects a package relative to that root and is used by
the resolution-based commands (`doctor`, `drift`, `setup --dry-run`,
`packs plan`, and `packs status`); `check` and `hooks` are unaffected because
they do not resolve the Effect dependency.

Resolution precedence for the _expected_ Effect identity:

1. The workspace target's matching root-lockfile importer (when `--workspace`
   is given), else the root importer — both only from a supported lockfile.
2. The workspace target's `package.json` (when targeted), else the root
   `package.json`, as the declared-intent fallback.

The installed `node_modules/effect/package.json` is used only for
verification, never as the source of the expected identity.

A workspace target may be given as the full importer path
(`packages/foldkit` or `./packages/foldkit`) or as the final path segment
(`foldkit`). When the basename is ambiguous (two packages share it), resolution
fails with a blocking `workspace-ambiguous` error and lists the matching
importers so you can disambiguate with the full path. A target that matches no
importer is a blocking `workspace-unresolved` error. A monorepo with no
`--workspace` resolves against the root importer exactly as a single-package
repository does, preserving existing behaviour.

Multiple Effect versions can coexist in one repository; the target's exact
version selects the matching reference pack.

## Exit codes

Every command sets the process exit code from its `MachineOutput.status`:

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | Ok — no errors or warnings.                                                        |
| `1`  | Warning — advisory condition (e.g. installed mismatch, stale/missing pack, drift). |
| `2`  | Error — blocking condition (e.g. missing Effect dependency, invalid command).      |

## Commands

### `effect-lens doctor`

Reports the project's Effect resolution, installed mismatch, reference-pack
status, and actionable diagnostics.

```sh
effect-lens doctor --project . --cache ~/.cache/effect-lens
```

Human output is a concise summary; `--json` emits a payload with
`machineOutput`, `resolution`, and `pack` (the `PackVerificationResult`).

### `effect-lens drift`

Emits a stable local drift report over the project's Effect dependency and
reference pack, serialized with the shared `DriftReport` contracts.

```sh
effect-lens drift --project . --cache ~/.cache/effect-lens --json
```

The report records the local toolchain manifest and one drift entry per
observed dependency/pack relationship. Full comparison against live upstream
tooling is not available in this offline slice; that limitation is surfaced
explicitly as a diagnostic and in the human output rather than inventing
compatibility.

### `effect-lens check`

Runs the available local read-only review path and aggregates findings and
diagnostics into a `MachineOutput`.

```sh
effect-lens check --project . --cache ~/.cache/effect-lens --path src
```

`check` runs oxlint (with the Lens plugin loaded) over the target path, feeds
the JSON diagnostics into the shared-core `review` operation, and aggregates
the resulting findings. `--path` is resolved relative to `--project` and
defaults to the project directory. If oxlint is unavailable or fails, a warning
diagnostic is emitted instead of crashing.

### `effect-lens setup --dry-run`

Builds a reviewable, ordered setup plan with no mutations. The plan inspects the
project's package manager, Effect dependency, reference-pack state, oxlint/Lens
configuration, and hook-manager state, and returns an ordered list of steps.

```sh
effect-lens setup --dry-run --project . --cache ~/.cache/effect-lens --json
```

`setup` requires an explicit mode: `--dry-run` (read-only) or `--apply`
(mutating). Running plain `setup` exits `2` with a message asking for one of
them. The plan format, read-only guarantee, and supported hook managers are
documented in [`docs/setup.md`](setup.md).

### `effect-lens setup --apply`

Applies the actionable setup plan explicitly. In this slice it applies only the
`hooks` step (installing the `effect-lens` check into the `hk` manager) and
reports every plan step as `applied` / `ok` / `deferred` / `refused` /
`skipped`. It refuses (writing nothing) when the plan contains an `unsupported`
step or the hooks target cannot be resolved. See [`docs/setup.md`](setup.md).

```sh
effect-lens setup --apply --project . --cache ~/.cache/effect-lens --json
```

### `effect-lens hooks status`

Reports the state of known hook managers and whether an `effect-lens` check is
installed, absent, or ambiguous.

```sh
effect-lens hooks status --project . --cache ~/.cache/effect-lens --json
```

The supported hook managers and detection rules are documented in
[`docs/setup.md`](setup.md).

### `effect-lens hooks install|uninstall`

Explicitly add or remove the Lens-owned `effect-lens` step in the `hk`
`pre-commit` hook. They are idempotent and refuse ambiguous or unsupported
configs without writing. See [`docs/setup.md`](setup.md).

```sh
effect-lens hooks install --project . --json
effect-lens hooks uninstall --project . --json
```

### `effect-lens packs status`

Builds a read-only reference-pack baseline/status report over the project's
exact Effect identity and an explicit catalog baseline. It is a thin adapter
over the shared-core `PackStatus.reportPackStatus` reporter and never fetches,
writes, deletes, or updates cache files.

```sh
effect-lens packs status --project . --cache ~/.cache/effect-lens --catalog ./catalog --json
```

`--catalog <dir>` is required, with the same layout as `packs plan`
(`<catalogDir>/<id>/manifest.json`). The report classifies the project's exact
pack as one of `unresolved`, `absent`, `stale`, `corrupt`, `complete`,
`mismatched`, or `verified`:

- `verified` — the exact pack is present, self-consistent, and matches the
  catalog baseline. Exit `0`.
- `complete` — the exact pack is present and self-consistent, but no catalog
  baseline entry pins it. Exit `0`.
- `absent` / `stale` / `corrupt` / `mismatched` — the exact pack is missing,
  lags a different version, is missing its own files, or diverges from the
  catalog baseline. Exit `1` (warning).
- `unresolved` — no exact target identity could be derived (no dependency, a
  range specifier, or a failed workspace target). Exit `2` (error).

The report also lists the same-name `candidateBaselines` the catalog offers
(catalog entries for `effect` that are not the exact target) as read-only
availability for a future freshness recommendation. No release-age, channel,
or ordering policy is applied here.

### `effect-lens packs plan`

Builds a read-only reference-pack acquisition plan over the project's exact
Effect identity and an explicit catalog baseline. It is a thin adapter over
the shared-core `planPackAcquisition` planner and never fetches, writes,
deletes, or updates cache files.

```sh
effect-lens packs plan --project . --cache ~/.cache/effect-lens --catalog ./catalog --json
```

`--catalog <dir>` is required and must be a directory of catalog entries, one
per subdirectory (`<catalogDir>/<id>/manifest.json`), loaded with
`loadPackCatalog`. The plan classifies the local pack state
(`already-complete`, `fetch-required`, `stale-pack-present`,
`partial-pack-present`, `catalog-entry-missing`, `resolution-unavailable`) and
returns an ordered, JSON-serializable plan. See `docs/contracts.md` for the
`PackPlan` contracts.

### `effect-lens packs fetch`

Explicitly acquires an exact reference pack into the cache. It is the only
command that invokes a pack transport; no other command fetches implicitly.
It requires an explicit `--catalog <dir>` and an exact `--id <pack-id>`
selection, loads the matching catalog entry, and invokes the shared
`acquirePack` executor with the local-directory transport.

```sh
effect-lens packs fetch --project . --cache ~/.cache/effect-lens --catalog ./catalog --id pack-effect-109 --json
```

The supported artifact format for this slice is a single local directory: the
catalog entry's `sourceUrl` points at a directory containing the pack's
included files plus a decodable `manifest.json` (as a `file://` URL or a plain
filesystem path). The transport stages that directory and hands it to
`acquirePack`, which verifies identity, version, integrity, path-traversal and
symlink safety, and content completeness before atomically promoting the pack
into `cacheDir/<packId>`. See `docs/contracts.md` for the `PackTransport` and
`PackAcquire` contracts.

An existing complete pack is a safe no-op (`already-present`, exit `0`); a
divergent cached pack is refused unless `--replace` is passed. Exact
version/source/integrity mismatches and malformed artifacts are refused before
any final cache mutation. Failures are reported as short, actionable
diagnostics without printing secrets or arbitrary response bodies.

## Offline, read-only, and mutation behavior

`doctor`, `drift`, `check`, `setup --dry-run`, `hooks status`, `packs plan`,
and `packs status` are strictly read-only:

- They never fetch reference packs or any network resource.
- They never mutate caches, lockfiles, `package.json`, or any project
  configuration.
- `check` writes a temporary oxlint config to the OS temp directory and removes
  it afterwards; it never writes into the project.
- `setup --dry-run` and `hooks status` never write hook files, oxlint config,
  dependencies, or packs.
- `packs plan` and `packs status` never write, delete, or update cache files.

`setup --apply`, `hooks install|uninstall`, and `packs fetch` are the explicit
mutation surfaces. They require an explicit command/flag and never mutate
implicitly. `packs fetch` mutates only the reference-pack cache
(`cacheDir/<packId>`), and only after every integrity, identity, and safety
check passes; it never touches project configuration.

## Current limitations

- `drift` is a local, offline slice. It reports the relationship between the
  declared/installed Effect dependency and the available reference pack, but it
  does not compare against live upstream tooling. That limitation is reported
  explicitly.
- `check` runs the Lens strict rules and the standard correctness/suspicious
  categories. It does not yet run the full `lookup`/`design`/state-pressure
  analysis surfaces.
- `setup --apply` and `hooks install|uninstall` mutate only the `hk` hook
  manager (`hk.pkl`); creating a `hk.pkl` from scratch (run `hk init` first)
  and mutating the other hook managers are out of scope for this slice.
- `packs fetch` supports a single local-directory artifact format. Remote
  (HTTP) acquisition and tarball/archive formats are intentionally out of
  scope for this slice; the transport boundary is injectable so a network
  adapter can be added later without changing the executor.
- `packs status` reports baseline availability from the explicit local catalog
  only. It does not query a registry or apply release-age/channel policy; that
  is the read-only freshness recommendation surface (issue #15), which will
  build on this baseline report.
- The CLI requires Node's native type stripping (Node 23.6+, or 22.6+ with
  `--experimental-strip-types`).

## Output contract

In `--json` mode every command emits a single JSON object. The `machineOutput`
field always carries the `MachineOutput` shape (`status`, `findings`,
`diagnostics`) so automation can rely on a stable, parseable result. Optional
fields serialize to `null` when absent, matching the shared core's JSON
contract.
