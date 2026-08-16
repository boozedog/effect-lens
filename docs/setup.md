# Effect Lens setup and hooks

This document describes the `setup` plan, the `hooks` reports and mutations,
the supported hook managers, and the mutating surfaces. `setup --dry-run` and
`hooks status` are strictly read-only: they never write config, dependencies,
packs, or hooks. `setup --apply` and `hooks install|uninstall` are the explicit
mutating surfaces and are described in their own sections below.

## Read-only guarantee

`setup --dry-run` and `hooks status` inspect a project and return a plan or
status report. They never:

- write or overwrite `package.json`, lockfiles, `.oxlintrc.json`, or any
  project configuration;
- fetch or mutate reference packs or caches;
- create, edit, or remove hook files or hook-manager configuration;
- install or uninstall dependencies.

The read-only guarantee is enforced by construction (the operations only read
files) and proven by tests that snapshot a project directory before and after
running each command and assert it is unchanged.

## `setup --dry-run`

`setup --dry-run` inspects the project and returns an ordered plan. Each step is
one of:

| Status        | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `ok`          | Already satisfied; no action needed.                                |
| `needed`      | An action would be required to complete setup (advisory `warning`). |
| `unsupported` | Cannot be completed with the detected tooling (blocking `error`).   |
| `skip`        | Not applicable to this project.                                     |

The plan steps, in order, are:

1. **`package-manager`** — detect the package manager from the lockfile or the
   `packageManager` field. npm and pnpm are supported (`ok`); yarn and bun are
   detected but unsupported (`unsupported`); no detected manager is
   `unsupported`.
2. **`effect-dependency`** — resolve the Effect dependency. `resolved` is `ok`;
   `missing`, `installed-mismatch`, and `missing-lockfile` are `needed`;
   `unsupported-lockfile`, `workspace-ambiguous`, and `workspace-unresolved`
   are `unsupported`.
3. **`reference-pack`** — verify the reference pack. `complete` is `ok`;
   `missing`, `stale`, and `partial` are `needed`; `skip` when no Effect
   dependency is declared.
4. **`oxlint-config`** — check the oxlint / Lens configuration. A parseable
   config referencing the Lens plugin or `lens/` rules is `ok`; a missing or
   non-Lens config is `needed`; an unreadable or unparseable config is
   `unsupported`.
5. **`hooks`** — check the hook-manager state. `installed` is `ok`; `absent` is
   `needed`; `ambiguous` is `unsupported`.

The exit code is derived from the plan: any `unsupported` step is an `error`
(exit `2`), otherwise any `needed` step is a `warning` (exit `1`), otherwise
`ok` (exit `0`). `ok` and `skip` steps produce no diagnostic.

### JSON output

`setup --dry-run --json` emits a single object:

```json
{
  "machineOutput": { "status": 1, "findings": [], "diagnostics": [] },
  "plan": {
    "project": "/abs/path",
    "packageManager": "pnpm@11.20.0 | null",
    "effect": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null } | null,
    "resolution": { "…": "…" },
    "pack": { "…": "…" },
    "oxlint": { "configPath": ".oxlintrc.json | null", "lensPluginConfigured": true, "status": "configured" },
    "hooks": { "lensStatus": "absent", "managers": [], "diagnostics": [] },
    "steps": [
      { "id": "package-manager", "title": "Detect package manager", "status": "ok", "detail": "pnpm detected" }
    ],
    "diagnostics": []
  }
}
```

`resolution` and `pack` reuse the shared `Resolution` and
`PackVerificationResult` contracts; `hooks` reuses the `HooksStatus` contract
below.

## `hooks status`

`hooks status` reports the state of the known hook managers and whether an
`effect-lens` check is installed. The aggregate `lensStatus` is:

| Status      | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `installed` | At least one manager has an `effect-lens` check.               |
| `absent`    | No manager has an `effect-lens` check (and none is ambiguous). |
| `ambiguous` | A manager is present but its config cannot be read.            |

The exit code is `0` when `installed`, `1` (warning) when `absent` or
`ambiguous`.

### Inspected hook managers

Lens inspects the following hook managers. Detection is content-based: a
present, readable config that references `effect-lens` is `installed`; a
readable config that does not is `absent`; an unreadable config is `ambiguous`.

| Manager            | Detected by                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hk`               | `hk.pkl` (or `hk.local.pkl` / `.config/hk.pkl`). A readable config that references `effect-lens` is `installed`.                                                                                                         |
| `husky`            | `.husky/` directory or a `husky` field in `package.json`. Any readable hook file under `.husky/` (pre-commit, pre-push, etc.) is scanned for `effect-lens`; the legacy `husky.hooks` config is read from `package.json`. |
| `lefthook`         | `lefthook.yml` or `lefthook.yaml`.                                                                                                                                                                                       |
| `pre-commit`       | `.pre-commit-config.yaml` or `.pre-commit-config.yml`.                                                                                                                                                                   |
| `lint-staged`      | a `lint-staged` field in `package.json`.                                                                                                                                                                                 |
| `simple-git-hooks` | a `simple-git-hooks` field in `package.json`.                                                                                                                                                                            |

Every known manager is reported (with `present: false` when absent) so the
output is complete and deterministic.

### JSON output

`hooks status --json` emits a single object:

```json
{
  "machineOutput": { "status": 1, "findings": [], "diagnostics": [] },
  "hooks": {
    "lensStatus": "absent",
    "managers": [
      {
        "manager": "husky",
        "present": false,
        "configPath": null,
        "lensStatus": "absent",
        "detail": "husky not detected"
      }
    ],
    "diagnostics": []
  }
}
```

## `setup --apply`

`setup --apply` is the explicit mutation mode for setup. It requires the
`--apply` flag; plain `setup` is rejected with a message asking for `--dry-run`
or `--apply`. `--apply` and `--dry-run` are mutually exclusive.

`setup --apply` builds the same read-only plan as `setup --dry-run`, then:

- **precondition** — refuses before any mutation when the plan contains an
  `unsupported` step (e.g. an unsupported package manager or an ambiguous hook
  manager), when the hooks step needs action but no supported hook target
  resolves, or when the `effect-lens` command is unavailable on `PATH`. A
  refused apply writes nothing.
- **applies** only the actionable, unambiguous **hooks** step (install the
  `effect-lens` check into the single supported manager).
- **reports** every step as `applied`, `ok`, `deferred`, `refused`, or
  `skipped`.

The dependency (`effect-dependency`), reference-pack (`reference-pack`), and
oxlint-config (`oxlint-config`) steps are reported as `deferred` when they need
action, because this slice does not install dependencies, fetch reference
packs, or create oxlint configuration. `setup --apply` never creates blanket
waivers, force flags, or hidden policy changes.

The exit code reflects the aggregate: `0` when the plan is fully satisfied,
`1` (warning) when steps remain deferred, and `2` (error) when the apply was
refused.

## `hooks install` and `hooks uninstall`

`hooks install` and `hooks uninstall` are the explicit hook-mutation surfaces.
They are idempotent and marker-based, and they always require an explicit
subcommand — `hooks` never mutates without `install` or `uninstall`.

### Ownership markers

Lens integrates with the existing `hk` config instead of overwriting it. When
it installs a check into `hk.pkl`, it adds a Lens-owned step to the `pre-commit`
hook's `steps` mapping, delimited by stable Pkl comment markers:

```pkl
// === effect-lens:start ===
["effect-lens"] {
  check = "'effect-lens' check --mode unified --changed"
}
// === effect-lens:end ===
```

The block is the only content Lens owns. `hooks uninstall` removes exactly that
block and leaves every other line and step untouched.

Re-running `hooks install` when the block is already present is a no-op (no
duplicate step is added); re-running `hooks uninstall` when nothing is
installed is a no-op.

### Scoped changed-file command

The generated step runs a **scoped unified changed-file gate** rather than an
unscoped `effect-lens check`:

- `--mode unified` preserves the repository's oxlint config (ignores,
  overrides, and rule settings) while loading the Lens rules, so the hook
  honours the same project policy as a full-tree scan.
- `--changed` lints only the staged changed files, so a pre-commit hook checks
  exactly what is about to be committed. Staged paths are read from Git
  (`git diff --cached --name-only --diff-filter=ACMR`), so deleted and
  unstaged-only files are excluded.

When `hooks install` or `setup --apply` receives an explicit `--workspace`, the
selected workspace is passed into the generated command so the hook lints only
that workspace's staged files:

```pkl
check = "'effect-lens' check --mode unified --changed --workspace 'packages/foldkit'"
```

With no `--workspace`, the hook operates over all staged paths under the root
config. The binary and workspace values are shell-quoted and the whole command
is Pkl-escaped when embedded in the `check` string, so a workspace or command
path containing spaces or shell metacharacters stays a single literal argument
and cannot break or inject into the hook.

`setup --apply` resolves the workspace target against the root lockfile and
refuses an unmatched or ambiguous target as a blocking error. `hooks install`
embeds the workspace verbatim without resolution validation, so an unmatched
target produces an empty changed scope (a clean pass) at runtime rather than a
blocking error.

Re-running `hooks install` when a Lens-owned block is already present is a
no-op, even if the generated command differs (for example the old unscoped
`effect-lens check` or a different `--workspace`). To refresh the installed
command, run `hooks uninstall` first and then `hooks install` again.

### Command availability requirement

Before `hooks install` or `setup --apply` writes `hk.pkl`, Lens verifies that
the `effect-lens` command is available on `PATH` (by running
`effect-lens --version`). If it is unavailable, the install refuses with an
actionable diagnostic (e.g. `npm install -g effect-lens`) and writes nothing,
so a generated hook can never reference a command that cannot run. The command
name defaults to `effect-lens` and can be overridden with the
`EFFECT_LENS_COMMAND` environment variable.

### Supported mutation targets

In this slice, only the `hk` hook manager is a mutation target. `hk` is
configured by a `hk.pkl` (Pkl) file, and Lens adds the `effect-lens` step to the
`pre-commit` hook. Two real-world `steps` shapes are supported:

- **inline** — `steps { ... }`: the Lens step is inserted before the mapping's
  closing brace.
- **variable reference** — `steps = <identifier>` (e.g. `steps = linters`): the
  line is rewritten to an inline mapping that spreads the variable and adds the
  step, e.g. `steps { ...linters <effect-lens step> }`.

Lens does **not** create a `hk.pkl` from scratch: hk's base config is
version-pinned, so the user runs `hk init` first. Other hook managers
(`husky`, `lefthook`, `pre-commit`, `lint-staged`, `simple-git-hooks`) are
inspected by `hooks status` but are not mutation targets in this slice.

hk config search is **first match wins, no merge**: a present `hk.local.pkl`
(and, in order, `.config/hk.local.pkl`, `hk.pkl`, `.config/hk.pkl`) shadows the
others. Lens targets whichever file hk would actually use. If that file has no
`pre-commit` steps to target, install refuses with an actionable diagnostic
rather than guessing at another config file.

### Refusal and failure behavior

`hooks install|uninstall` refuses (and writes nothing) when:

- the hk config is present but unreadable (`ambiguous`);
- `install` finds no `hk.pkl` (run `hk init` first);
- `install` finds the `effect-lens` command unavailable on `PATH` (install it
  first, e.g. `npm install -g effect-lens`);
- `install`/`uninstall` finds an `effect-lens` reference that is not a
  Lens-owned step (a bare `["effect-lens"]` step or a reference in another
  hook), and cannot take ownership safely;
- the `pre-commit` hook or its `steps` cannot be located, or the `steps` value
  is not an inline mapping or a simple variable reference;
- `install`/`uninstall` finds a malformed Lens block (unclosed or stray
  start/end markers; install also refuses rather than no-op'ing on one).

`install` is a no-op when a Lens-owned step is already present; `uninstall` is a
no-op when no Lens-owned step is installed. Every refusal happens before any
file is written, so a mutation is never partial.

## Contracts

The plan and status models live in `src/Setup.ts`, `src/SetupApply.ts`,
`src/Hooks.ts`, and `src/HookMutation.ts` and are Schema-backed and
JSON-serializable, matching the shared core contract conventions. The
operations live in `src/operations/setup.ts`, `src/operations/setupApply.ts`,
`src/operations/hooks.ts`, and `src/operations/hookMutation.ts`; the CLI
commands are thin adapters over them.

### Safety tests

Install, uninstall, repeat application, preservation of non-Lens content,
refusal of missing/ambiguous/unsupported/not-owned/malformed targets, and the
no-partial-write guarantee are covered by tests that run against temporary
project directories, so no committed fixture is ever mutated.

### Deferred mutation paths

The following mutating behavior remains intentionally out of scope for this
slice and is reported (not silently skipped):

- Dependency installation, reference-pack fetching, and oxlint-config creation
  (`setup --apply` reports these steps as `deferred`).
- Creating a `hk.pkl` from scratch (run `hk init` first; hk's base config is
  version-pinned).
- Hook mutation for husky, lefthook, pre-commit, lint-staged, and
  simple-git-hooks.
- pi integration (deferred as a separate issue).
