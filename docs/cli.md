# Effect Lens CLI

The `effect-lens` CLI is a thin adapter over the shared core
operations. It exposes seven commands — `doctor`, `drift`, `check`, `setup`,
`hooks`, `packs`, and `freshness` — that
inspect a project's Effect tooling and report findings and diagnostics with
stable human-readable and machine-readable output and stable exit codes.

The CLI never re-implements policy: every command delegates to the shared core
operations in `src/operations/` and the shared contracts in `src/`. It never
mutates project configuration. `doctor`, `drift`, `check`, `setup --dry-run`,
`hooks status`, `packs plan`, `packs status`, and `freshness` are read-only;
`freshness` is the only network-backed command (it fetches an explicit registry
snapshot); the rest never fetch packs or mutate caches. `setup --apply`,
`hooks install|uninstall`, and `packs fetch` are the explicit mutation surfaces.

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
| `--catalog <dir>`     | Reference-pack catalog baseline directory (packs status/plan/fetch and freshness).                 |
| `--id <pack-id>`      | Exact catalog entry id to fetch (packs fetch only).                                                |
| `--replace`           | Replace a divergent cached pack (packs fetch only).                                                |
| `--cooldown-days <n>` | Minimum release age in days before a candidate is recommended (freshness only).                    |
| `--registry <url>`    | Registry endpoint (freshness only; default `https://registry.npmjs.org`).                          |
| `--exclude <ver>`     | Exclude a version from recommendation (freshness only; repeatable).                                |
| `-j, --json`          | Emit machine-readable JSON instead of human-readable text.                                         |
| `--mode <mode>`       | Check gate mode: `lens-only` (default) or `unified` (check only).                                  |
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
`packs plan`, `packs status`, and `freshness`); `check` and `hooks` are unaffected because
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
diagnostics into a `MachineOutput`. `check` is a configurable unified gate
foundation: it normalizes toolchain diagnostics through registered rule
providers (the Lens strict rules are the first provider, followed by the
Foldstryx first-party provider) and surfaces the result as stable findings and
diagnostics.

```sh
effect-lens check --project . --cache ~/.cache/effect-lens --path src
effect-lens check --project . --cache ~/.cache/effect-lens --mode unified --path src
```

`check` runs oxlint (with the Lens plugin loaded) over the target path, feeds
the JSON diagnostics into the shared-core `review` operation, and aggregates
the resulting findings. `--path` is resolved relative to `--project` and
defaults to the project directory. If oxlint is unavailable or fails, a warning
diagnostic is emitted instead of crashing.

#### Gate modes

`check` supports two gate modes, selected with `--mode`:

- **`lens-only`** (default) — preserves the existing single-package Lens
  behavior. A fresh scratch oxlint config loads the Lens rules and the standard
  correctness/suspicious/perf categories. The target repository's own oxlint
  config is not consulted, and diagnostics that no provider recognizes are
  surfaced as advisory `off` notes that do not affect the exit status.
- **`unified`** — a config-preserving gate. The target repository's oxlint
  config (`.oxlintrc.json`, `.oxlintrc`, or `oxlint.json`) is loaded and
  composed with the Lens plugin and rules, so the project's ignores, overrides,
  categories, and rule settings are preserved while the Lens rules are loaded.
  Diagnostics that no provider recognizes are surfaced as visible diagnostics
  with their raw oxlint severity (never silently dropped as `off`), so unknown
  project diagnostics are visible in the gate.

#### Configuration precedence (unified mode)

In `unified` mode the composed config preserves the project's settings and
adds the Lens rules without overriding them:

1. The project's own oxlint config is the base: its `ignorePatterns`,
   `overrides`, `categories`, and `rules` are preserved verbatim.
2. The Lens plugin is appended to `jsPlugins` (deduplicated by resolved path)
   when the project does not already load it.
3. Each Lens rule that the project does not already set is added at its catalog
   severity. A project rule setting (including `off`) is never overridden.

When the project has no oxlint config, `unified` mode falls back to the same
built-in config as `lens-only`. When the project config cannot be parsed, a
`check-config-unparseable` warning diagnostic is emitted and the built-in
config is used rather than crashing. An invalid `--mode` value (anything other
than `lens-only` or `unified`) is rejected with exit `2`.

#### Read-only guarantee

`check` is read-only in both modes. In `lens-only` mode the scratch config is
written to the OS temp directory. In `unified` mode the composed config is
written to a transient `.effect-lens-check-oxlintrc-<pid>-<ts>.json` file in
the project directory (a unique name avoids collisions between concurrent
runs) so relative ignore/override/plugin paths resolve correctly, and it is
removed in a `finally` block — it is never left behind and the project's own
config is never modified. If the transient file cannot be written (for example
a read-only project directory), a warning diagnostic is emitted instead of
crashing.

#### Foldstryx provider and migration

`check` recognizes supported Foldstryx diagnostics (`foldstryx(no-async-function)`,
`foldstryx(no-await-expression)`, `foldstryx(no-new-promise)`) through the
registered Foldstryx provider. It never requires Foldstryx to be installed: it
only recognizes diagnostic codes, so single-project Lens use is unaffected.
Each supported Foldstryx rule maps explicitly to the canonical Lens rule that
enforces the same Effect-first policy (see `docs/contracts.md`).

During migration a project may run both Foldstryx and the Lens strict rules.
`check` avoids duplicate gate findings for equivalent diagnostics that refer to
the same canonical rule and location:

- The canonical Lens finding is kept; a redundant Foldstryx diagnostic at the
  same rule/location becomes a `warning` migration diagnostic (id
  `review-migration-*`) that names the redundant rule, the Lens equivalent, and
  the location.
- The `review` payload's `migration` field is a read-only migration report
  listing each redundant Foldstryx rule, its canonical Lens equivalent, and how
  many overlapping locations were observed. The human output prints a
  `migration:` section with the same recommendation.
- A Foldstryx diagnostic at a location with no equivalent Lens finding is kept
  as a finding with `provider: "foldstryx"` provenance so it is never silently
  dropped.

The migration report and diagnostics are advisory and never mutate config.

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
availability for the freshness recommendation (issue #15). No release-age, channel,
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

### `effect-lens freshness`

Advises on the newest Effect version allowed by the channel and
release-age/cooldown policy, and the required reference pack. It is the
network-backed, read-only freshness surface (issue #15): it resolves the
project's Effect identity, fetches an explicit registry snapshot, and reports
the installed version, declared channel, newest allowed candidate, cooldown/age
result, and the candidate's reference-pack status.

```sh
effect-lens freshness --project . --workspace packages/foldkit --cache ~/.cache/effect-lens --catalog ./catalog --json
```

`freshness` is the ONLY network-backed command. It fetches the `effect` package
metadata from the npm registry (or `--registry <url>`) using an explicit HTTP
client; it never invokes `npm` and never mutates package manifests, lockfiles,
or pack caches. It is strictly read-only and advisory — dependency mutation is
left to Nub.

Options:

- `--catalog <dir>` — optional reference-pack catalog baseline. When provided,
  the recommendation reports the candidate's pack status (`available`,
  `not-cached`, or `catalog-missing`); without it the pack status is `unknown`.
- `--cooldown-days <n>` — minimum release age in days before a candidate is
  recommended (default `0`).
- `--registry <url>` — registry endpoint (default `https://registry.npmjs.org`).
- `--exclude <ver>` — exclude a version from recommendation (repeatable).

The recommendation classifies the outcome as one of:

- `recommendation` — a newer allowed candidate exists and passes the cooldown.
  Exit `1` (warning).
- `cooldown` — a newer allowed candidate exists but fails the cooldown. Exit `1`.
- `up-to-date` — the installed version is the newest allowed candidate. Exit `0`.
- `no-candidate` — no newer allowed candidate could be selected. Exit `0`.
- `unresolved` — no exact installed Effect version could be derived. Exit `2`.
- `network-error` — the registry snapshot could not be fetched. Exit `1`.

Channel policy: a project may move to any prerelease channel at or after its
declared channel in `alpha < beta < rc < stable` order. A beta project MAY be
recommended an RC, but only because the policy explicitly permits it — a beta
range is never assumed to include an RC. The policy is injectable and
documented in `docs/contracts.md`.

A missing candidate pack is reported as an actionable `catalog-missing` /
`not-cached` result, never fetched implicitly.

## Offline, read-only, and mutation behavior

`doctor`, `drift`, `check`, `setup --dry-run`, `hooks status`, `packs plan`,
`packs status`, and `freshness` are strictly read-only:

- They never mutate package manifests, lockfiles, or any project configuration.
- `doctor`, `drift`, `check`, `setup --dry-run`, `hooks status`, `packs plan`,
  and `packs status` never fetch any network resource.
- `freshness` is the only network-backed command: it fetches an explicit
  registry snapshot and never mutates anything. Offline commands remain
  offline; `freshness` requires network access to the registry and reports a
  `network-error` result when the fetch fails.
- `check` writes a temporary oxlint config to the OS temp directory and removes
  it afterwards; in `unified` mode it writes a transient composed config into
  the project directory and removes it in a `finally` block, never leaving an
  artifact and never modifying the project's own config.
- `setup --dry-run` and `hooks status` never write hook files, oxlint config,
  dependencies, or packs.
- `packs plan`, `packs status`, and `freshness` never write, delete, or update
  cache files.

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
  analysis surfaces. The Lens and Foldstryx providers are registered; the
  StyleX first-party provider is a later slice and registers through the same
  seam.
- `setup --apply` and `hooks install|uninstall` mutate only the `hk` hook
  manager (`hk.pkl`); creating a `hk.pkl` from scratch (run `hk init` first)
  and mutating the other hook managers are out of scope for this slice.
- `packs fetch` supports a single local-directory artifact format. Remote
  (HTTP) acquisition and tarball/archive formats are intentionally out of
  scope for this slice; the transport boundary is injectable so a network
  adapter can be added later without changing the executor.
- `packs status` reports baseline availability from the explicit local catalog
  only. It does not query a registry or apply release-age/channel policy; that
  is the read-only freshness recommendation surface (issue #15), which builds
  on this baseline report and is exposed as the `freshness` command.
- `freshness` requires network access to the npm registry (or `--registry`). It
  is the only network-backed command; offline commands remain offline. A
  registry fetch failure is reported as a `network-error` result, never a
  crash. The channel policy default is the "more mature" rule (a project may
  move to any channel at or after its declared channel); a stricter policy is
  injectable but not yet exposed as a CLI flag.
- The CLI requires Node's native type stripping (Node 23.6+, or 22.6+ with
  `--experimental-strip-types`).

## Output contract

In `--json` mode every command emits a single JSON object. The `machineOutput`
field always carries the `MachineOutput` shape (`status`, `findings`,
`diagnostics`) so automation can rely on a stable, parseable result. Optional
fields serialize to `null` when absent, matching the shared core's JSON
contract.
