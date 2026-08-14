# Effect Lens setup and hooks

This document describes the read-only `setup --dry-run` plan and the `hooks
status` report, the supported hook managers, and the deferred mutating
behavior. Both commands are strictly read-only: they never write config,
dependencies, packs, or hooks.

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
   `unsupported-lockfile` is `unsupported`.
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

### Supported hook managers

Lens inspects the following hook managers. Detection is content-based: a
present, readable config that references `effect-lens` is `installed`; a
readable config that does not is `absent`; an unreadable config is `ambiguous`.

| Manager            | Detected by                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
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

## Deferred mutations

The following are intentionally not implemented in this slice and are
rejected by the CLI:

- `setup` without `--dry-run` exits `2` with "setup mutation is not yet
  implemented".
- `hooks install` and `hooks uninstall` are not implemented; `hooks` requires
  the `status` subcommand.

When mutation is added, it MUST:

- require an explicit command (never mutate implicitly);
- preserve unrelated user configuration and existing hook-manager files;
- never create blanket waivers to make checks pass;
- be covered by safety tests proving no unrelated files change.

## Contracts

The plan and status models live in `src/Setup.ts` and `src/Hooks.ts` and are
Schema-backed and JSON-serializable, matching the shared core contract
conventions. The operations live in `src/operations/setup.ts` and
`src/operations/hooks.ts`; the CLI commands are thin adapters over them.
