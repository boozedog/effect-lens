# Effect Lens core contracts

This document defines the stable internal data contracts shared by every Effect
Lens surface: the CLI, the pi extension, and the future MCP adapter. All models
live in `src/`, are defined with Effect `Schema`, and MUST NOT be redefined by
any consumer adapter.

Serialization is JSON. Each `Schema.Class` encodes to a plain JSON object with
`Schema.encodeSync` and decodes from JSON with `Schema.decodeUnknownSync`.
Optional fields are modelled with `Schema.OptionFromNullOr` and serialize to
`null` when absent and to their value when present.

## Rule catalog and oxlint plugin

The strict rule layer lives in two places that MUST stay in sync:

- **`src/rules/`** — the Lens rule catalog. Each entry is a `Rule` value whose
  `id` is the stable identifier (`lens/no-async-function`,
  `lens/no-await-expression`, `lens/no-new-promise`) used by CLI, pi, and Git
  gates. All three initial rules are `lens-strict` kind: they are Lens
  strict-policy footgun rules, not upstream Effect rules, and their evidence
  documents the footgun and the Effect alternative rather than claiming a
  universal upstream ban.
- **`src/plugin/`** — the oxlint plugin. It is loaded by oxlint via the
  `jsPlugins` entry in `.oxlintrc.json` and exposes the same rules under the
  `lens` plugin name. The rules use AST and binding information (never text
  matching) and are bind-aware: aliases and shadowing are caught where the
  oxlint scope API supports it.

The plugin is written against `@oxlint/plugins` — the same API the upstream
`@effect/oxc` package uses. `@effect/oxc` itself is `private` (not published),
so Lens references its conventions rather than depending on it. The
`effect-oxlint` third-party wrapper is avoided because it is built against an
older Effect prerelease.

### Rule IDs and oxlint codes

The Lens rule id uses a slash (`lens/no-async-function`). The oxlint JSON
diagnostic `code` uses the `plugin(rule)` form (`lens(no-async-function)`).
`toRuleId` in `src/plugin/toFinding.ts` converts between them, and `toFinding`
maps an oxlint diagnostic to a Lens `Finding` (rule id, severity, source kind,
location, and catalog evidence). Non-Lens diagnostics are never coerced into
Lens findings.

### Narrow interop bridge

`lens/no-await-expression` allows only one narrow, explicit, bind-aware bridge:
`await <effectImport>.runPromise(...)` where the receiver resolves to an import
binding from the `effect` package. The allowlist is a method-name list in
`src/plugin/allowlist.ts`; it is not a path list and must not grow with file
paths. The local name is irrelevant, so `import { Effect as Eff }` and
`import * as Eff` are handled correctly. A locally-declared or shadowed object
cannot bypass the ban.

### Fixtures and tests

`test/fixtures/rules/` holds passing, failing, alias, shadowing, and
allowed-bridge fixtures for each rule. `test/plugin.test.ts` runs the real
oxlint CLI against them and asserts on the JSON diagnostics and stable rule
ids, and checks that every catalog rule id maps to a plugin rule key and vice
versa. The fixtures are excluded from the main lint config; the Lens source and
the non-fixture tests remain compliant with the strict rules.

## Cross-cutting concepts

- **Package identity** (`PackageIdentity`) is the npm dependency identity taken
  from the lockfile, `package.json`, or the installed package. It is distinct
  from **upstream identity** (`UpstreamRef`), which is the source commit/ref of
  the upstream Effect material. These are separate types on purpose: the
  installed version can be current while a reference pack points at a stale
  commit, and vice versa.
- **Source kind** (`"upstream" | "lens-strict"`) records whether guidance or a
  finding reflects upstream Effect practice or Lens strict policy. Lens
  strict-policy rules are never presented as unqualified upstream authority.
- **Every finding carries** its rule id, severity, source kind, version
  applicability, location, and evidence. There is no bare "text match" finding.

## `Provenance` — src/Provenance.ts

### `SourceKind`

Literal union. Values:

```json
"upstream" | "lens-strict"
```

### `UpstreamRef`

Identity of upstream source material.

```json
{
  "repository": "effect-ts/effect",
  "ref": "v4.0.0-rc.109 | null",
  "commit": "deadbeef | null",
  "sourceUrl": "https://github.com/effect-ts/effect | null"
}
```

### `Attribution`

Licensing/attribution metadata required when Lens reproduces upstream material.

```json
{
  "license": "MIT | null",
  "copyright": "… | null",
  "notice": "… | null"
}
```

### `Evidence`

A single traceable piece of evidence for a guidance item or finding.

```json
{
  "source": "packages/effect/src/Effect.ts",
  "ref": "v4.0.0-rc.109 | null",
  "location": "src/Effect.ts:120 | null",
  "snippet": "… | null",
  "attribution": "… | null"
}
```

## `PackageIdentity` — src/PackageIdentity.ts

### `PackageSource`

Literal union:

```json
"package.json" | "lockfile" | "installed"
```

`lockfile` is preferred for reproducibility; `installed` reflects disk state.

### `PackageIdentity`

```json
{
  "name": "effect",
  "version": "4.0.0-rc.109",
  "source": "lockfile",
  "integrity": "sha512-… | null"
}
```

`samePackage(a, b)` is `true` when both names and versions match, regardless of
source.

## `Severity` — src/Severity.ts

Literal union shared by rules, findings, and diagnostics:

```json
"off" | "warning" | "error"
```

## `Guidance` — src/Guidance.ts

### `GuidanceAppliesTo`

A semver window. `from` inclusive; `to` (when present) exclusive.

```json
{ "from": "4.0.0", "to": "4.1.0 | null" }
```

### `GuidanceValidationStatus`

```json
"validated" | "unvalidated" | "conflict"
```

Contradictory sources MUST surface as `"conflict"`, never silently merged.

### `Guidance`

```json
{
  "id": "g-effect-pipe",
  "topic": "piping",
  "summary": "Prefer pipe for composition.",
  "source": "upstream",
  "appliesTo": { "from": "4.0.0", "to": null } | null,
  "upstreamRef": { "repository": "…", "ref": null, "commit": null, "sourceUrl": null } | null,
  "validationStatus": "validated",
  "evidence": []
}
```

## `Rule` — src/Rule.ts

### `RuleKind`

```json
"upstream-aligned" | "lens-strict"
```

A rule labeled `upstream-aligned` MUST carry evidence from the Effect repository
or published tooling.

### `Rule`

```json
{
  "id": "lens/no-async-function",
  "title": "No async functions",
  "kind": "lens-strict",
  "severity": "error",
  "rationale": "async/await is not Effect-first.",
  "evidence": [],
  "exceptions": ["src/bridge.ts"]
}
```

`id` is the stable identifier used by CLI, pi, and Git gates.

## `Waiver` — src/Waiver.ts

### `WaiverScope`

```json
"global" | "path" | "file"
```

Narrow scope is preferred. There is no blanket disable mechanism.

### `Waiver`

```json
{
  "id": "w-1",
  "rule": "lens/no-async-function",
  "scope": "file",
  "path": "src/bridge.ts | null",
  "reason": "Interop boundary with a legacy callback API.",
  "createdBy": "david",
  "expiresAt": "2026-09-01T00:00:00.000Z | null"
}
```

`rule`, `scope`, and `reason` are required. `expiresAt` supports waiver ratchets.

## `Finding` — src/Finding.ts

### `FindingLocation`

```json
{
  "file": "src/service.ts",
  "line": 14,
  "column": 3 | null,
  "snippet": "… | null"
}
```

### `Finding`

```json
{
  "id": "f-1",
  "rule": "lens/no-async-function",
  "severity": "error",
  "source": "lens-strict",
  "message": "Prefer Effect composition.",
  "appliesTo": { "from": "4.0.0", "to": null } | null,
  "location": { "file": "src/service.ts", "line": 14, "column": 3, "snippet": null },
  "evidence": [],
  "waivers": []
}
```

### `Diagnostic`

A non-rule diagnostic (toolchain or resolution problem). Same shape as a finding
minus evidence/waivers/rule.

## `ExitStatus` — src/ExitStatus.ts

```json
0 | 1 | 2
```

`0` = ok, `1` = warning, `2` = error. `aggregateStatus` derives the status from
findings + diagnostics: any `error` → `2`; else any `warning` → `1`; else `0`.

### `MachineOutput`

The machine-readable result emitted by CLI, pi, and Git gates.

```json
{
  "status": 2,
  "findings": [],
  "diagnostics": []
}
```

## `ReferencePack` — src/ReferencePack.ts

### `PackStatus`

```json
"missing" | "partial" | "complete" | "stale"
```

### `PackManifest`

```json
{
  "id": "pack-effect-109",
  "effectVersion": "4.0.0-rc.109",
  "packageIdentity": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null },
  "upstream": { "repository": "effect-ts/effect", "ref": "v4.0.0-rc.109", "commit": "deadbeef", "sourceUrl": null },
  "includedPaths": ["LLMS.md", "ai-docs"],
  "sourceUrl": "https://github.com/effect-ts/effect | null",
  "integrity": "sha512-… | null",
  "attribution": { "license": "MIT", "copyright": null, "notice": null } | null,
  "status": "complete"
}
```

### `PackVerification`

Result of checking a manifest against the on-disk cache:
`manifest`, `missingFiles: string[]`, `metadataChanged: boolean`,
`stale: boolean`, `message: string | null`.

## `Resolver` — src/Resolver.ts

Resolves the project's expected Effect package identity from committed project
metadata and verifies it against the installed package. The expected identity
is always derived from reproducible, committed metadata; the installed package
is used only for verification.

### `LockfileKind`

```json
"package-lock" | "pnpm-lock" | "yarn-lock" | "bun-lock" | "missing"
```

`package-lock` and `pnpm-lock` are supported. `yarn-lock` and `bun-lock` are
detected but reported as unsupported rather than guessed at.

### `ResolutionStatus`

```json
"resolved" | "installed-mismatch" | "missing-lockfile" | "unsupported-lockfile" | "missing"
```

- `resolved` — expected identity derived from a supported lockfile and the
  installed package (when present) matches.
- `installed-mismatch` — expected identity derived, but the installed package
  version differs (a declared-vs-installed conflict).
- `missing-lockfile` — no usable supported lockfile (absent or unparseable);
  expected identity came from `package.json`.
- `unsupported-lockfile` — a lockfile exists but is not supported; expected
  identity came from `package.json`.
- `missing` — no `effect` dependency is declared in any committed metadata.

### `Resolution`

```json
{
  "expected": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null } | null,
  "installed": { "name": "effect", "version": "4.0.0-rc.109", "source": "installed", "integrity": null } | null,
  "lockfile": "pnpm-lock",
  "status": "resolved",
  "detail": "… | null"
}
```

### Resolution precedence

The expected identity is derived in this order:

1. `package-lock.json` (npm) — preferred when present.
2. `pnpm-lock.yaml` (pnpm) — preferred when present.
3. `package.json` declared `effect` specifier — fallback when no supported
   lockfile is present or the lockfile has no `effect` entry.

`yarn.lock` and `bun.lock`/`bun.lockb` are detected but reported as
`unsupported-lockfile`; Lens does not guess at their format. The installed
package (`node_modules/effect/package.json`) is never the source of the
expected identity — it is compared against the expected identity to surface
`installed-mismatch`.

The installed comparison is only performed when the expected identity came from
a supported lockfile (`source: "lockfile"`). When the expected identity came
from the `package.json` fallback (a specifier that may be a range), it is not
compared to the installed exact version, so a range never surfaces as a false
`installed-mismatch`. A present-but-unparseable lockfile is reported as
`missing-lockfile` with a distinct "could not be parsed" detail.

## `PackVerifier` — src/PackVerifier.ts

Verifies Lens-managed reference packs against the on-disk cache and the
project's expected Effect identity. The cache layout is
`cacheDir/<packId>/manifest.json` plus the pack's included files under
`cacheDir/<packId>/<includedPath>`. Verification is read-only: it never
fetches or mutates network/cache state.

### `PackVerificationResult`

```json
{
  "resolution": { "expected": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null }, "installed": { "name": "effect", "version": "4.0.0-rc.109", "source": "installed", "integrity": null }, "lockfile": "pnpm-lock", "status": "resolved", "detail": null },
  "pack": { "id": "pack-effect-109", "…": "…" } | null,
  "verification": { "manifest": { "…": "…" }, "missingFiles": [], "metadataChanged": false, "stale": false, "message": null } | null,
  "status": "complete",
  "message": "… | null"
}
```

`findPack` is a strict content locator: it returns only a pack whose package
identity matches the expected identity exactly (name and version). A
version-lagging pack is surfaced as `stale` by `verifyReferencePack`, which
falls back to the first same-name pack when no exact match exists.
`verifyReferencePack` maps the detailed check to a `PackStatus`:

- `missing` — no pack exists for the package, or the project declares no
  `effect` dependency.
- `stale` — a pack exists but its pinned Effect version differs from the
  expected identity.
- `partial` — the pack matches but some included files are missing or the
  on-disk metadata has changed.
- `complete` — the pack matches and all included files are present.

`verifyPack` detects `metadataChanged` by comparing a caller-supplied baseline
manifest against the stored `manifest.json`. `verifyReferencePack` reads the
stored manifest as its own baseline, so it cannot observe metadata drift until
a pin/catalog baseline exists; use `verifyPack` with an external baseline for
that check.

## `Drift` — src/Drift.ts

### `DriftKind`

```json
"compatible" | "stale" | "missing" | "conflict"
```

### `ToolchainManifest`

```json
{
  "lensVersion": "0.0.0",
  "effect": {
    "name": "effect",
    "version": "4.0.0-rc.109",
    "source": "lockfile",
    "integrity": null
  },
  "packageManager": "pnpm@11.20.0 | null",
  "node": "v24.19.0 | null"
}
```

### `DriftEntry`

```json
{
  "packageIdentity": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null },
  "expected": { "repository": "…", "ref": null, "commit": null, "sourceUrl": null } | null,
  "actual": { "repository": "…", "ref": null, "commit": null, "sourceUrl": null } | null,
  "kind": "compatible",
  "detail": "… | null"
}
```

### `DriftReport`

```json
{
  "toolchain": { "lensVersion": "0.0.0", "effect": { … }, "packageManager": null, "node": null },
  "entries": [],
  "generatedAt": "2026-08-14T00:00:00.000Z"
}
```

## Invariants enforced by the schema

- A `Finding` always has `rule`, `severity`, `source`, `location`, and at least
  the evidence array (possibly empty).
- A `Waiver` always has `rule`, `scope`, and `reason`.
- Package identity and upstream commit identity are distinct types.
- `GuidanceValidationStatus` and `DriftKind` surface conflicts explicitly.

## Reference data test matrix

`test/ReferenceData.test.ts` covers the four reference-data states required by
issue #5 acceptance criteria: `compatible`, `stale`, `missing`, and `conflict`.
`test/Serialization.test.ts` proves lossless JSON round-trips for `MachineOutput`,
`PackManifest`, `Guidance`, `Rule`, and `DriftReport`.

`test/Resolver.test.ts` covers identity resolution across valid pnpm/npm
lockfiles, a missing lockfile, an installed-version mismatch, an unsupported
lockfile (yarn and bun), an unparseable lockfile (including a range specifier
that must not become a false conflict), a missing dependency, and a dogfood
check against this repository's real lockfile. `test/PackVerifier.test.ts`
covers pack lookup, `metadataChanged` detection, and the `missing` / `stale` /
`partial` / `complete` pack statuses.
