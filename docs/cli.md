# Effect Lens CLI

The `effect-lens` CLI is a thin, read-only adapter over the shared core
operations. It exposes five commands — `doctor`, `drift`, `check`, `setup`, and
`hooks` — that
inspect a project's Effect tooling and report findings and diagnostics with
stable human-readable and machine-readable output and stable exit codes.

The CLI never re-implements policy: every command delegates to the shared core
operations in `src/operations/` and the shared contracts in `src/`. It never
fetches packs, never mutates caches, and never mutates project configuration.

## Running the CLI

From a checked-out project:

```sh
effect-lens <command> [options]
```

Within this repository, the same entrypoint is available as:

```sh
pnpm cli -- <command> [options]
```

The CLI runs the TypeScript entrypoint with Node's native type stripping, so it
requires Node 23.6+ (or Node 22.6+ with `--experimental-strip-types`, which the
`bin/effect-lens.mjs` launcher passes automatically).

## Global options

| Option                | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `-p, --project <dir>` | Project directory to inspect (default: current directory).                                         |
| `-c, --cache <dir>`   | Reference-pack cache directory (default: `$XDG_CACHE_HOME/effect-lens` or `~/.cache/effect-lens`). |
| `-j, --json`          | Emit machine-readable JSON instead of human-readable text.                                         |
| `-h, --help`          | Print usage.                                                                                       |
| `-v, --version`       | Print the version.                                                                                 |

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

`setup` requires `--dry-run`; running `setup` without it exits `2` because
actual setup mutation is not yet implemented. The plan format, read-only
guarantee, and supported hook managers are documented in
[`docs/setup.md`](setup.md).

### `effect-lens hooks status`

Reports the state of known hook managers and whether an `effect-lens` check is
installed, absent, or ambiguous.

```sh
effect-lens hooks status --project . --cache ~/.cache/effect-lens --json
```

`hooks` requires the `status` subcommand; `hooks install` and `hooks uninstall`
are deferred. The supported hook managers and detection rules are documented in
[`docs/setup.md`](setup.md).

## Offline and read-only behavior

All five commands are strictly read-only:

- They never fetch reference packs or any network resource.
- They never mutate caches, lockfiles, `package.json`, or any project
  configuration.
- `check` writes a temporary oxlint config to the OS temp directory and removes
  it afterwards; it never writes into the project.
- `setup --dry-run` and `hooks status` never write hook files, oxlint config,
  dependencies, or packs.

## Current limitations

- `drift` is a local, offline slice. It reports the relationship between the
  declared/installed Effect dependency and the available reference pack, but it
  does not compare against live upstream tooling. That limitation is reported
  explicitly.
- `check` runs the Lens strict rules and the standard correctness/suspicious
  categories. It does not yet run the full `lookup`/`design`/state-pressure
  analysis surfaces.
- `setup` mutation and `hooks install|uninstall` (from issue #9) are not yet
  implemented; `setup --dry-run` and `hooks status` are read-only by design.
- The CLI requires Node's native type stripping (Node 23.6+, or 22.6+ with
  `--experimental-strip-types`).

## Output contract

In `--json` mode every command emits a single JSON object. The `machineOutput`
field always carries the `MachineOutput` shape (`status`, `findings`,
`diagnostics`) so automation can rely on a stable, parseable result. Optional
fields serialize to `null` when absent, matching the shared core's JSON
contract.
