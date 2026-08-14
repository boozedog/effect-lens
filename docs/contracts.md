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
- **Source kind** (`"upstream" | "lens-strict" | "lens-advisory"`) records
  whether guidance or a finding reflects upstream Effect practice, Lens strict
  policy, or Lens advisory design analysis. Lens strict-policy rules are never
  presented as unqualified upstream authority, and advisory design
  recommendations (e.g. `@typeonce/effect-machine`) are never presented as
  strict rules or as upstream Effect guidance.
- **Every finding carries** its rule id, severity, source kind, version
  applicability, location, and evidence. There is no bare "text match" finding.

## `Provenance` — src/Provenance.ts

### `SourceKind`

Literal union. Values:

```json
"upstream" | "lens-strict" | "lens-advisory"
```

`lens-advisory` marks advisory design recommendations (see `statePressure`). It
is additive and backward-compatible: existing `"upstream"` and `"lens-strict"`
values still decode, and no exhaustive `src/` switch breaks.

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

## `PackPlan` — src/PackPlan.ts

Read-only reference-pack acquisition planning over the existing resolver and
verifier contracts. The planner derives the project's exact Effect identity via
the resolver, classifies the local pack state, and returns an ordered,
JSON-serializable plan of read-only actions. It never fetches, writes, deletes,
or updates cache files, and it never adds implicit network behavior to other
commands. Network acquisition and atomic promotion are deferred to a later
slice.

The catalog input is explicit: callers pass the entries directly or load them
with `loadPackCatalog`. The catalog is the ONLY place the planner learns a
source; it never invents a URL from a version string.

### `PackPlanAction`

```json
[
  "already-complete",
  "fetch-required",
  "stale-pack-present",
  "partial-pack-present",
  "catalog-entry-missing",
  "resolution-unavailable"
]
```

- `already-complete` — an exact, intact local pack is present. A complete exact
  pack is already complete even without a catalog entry (presence beats source;
  the catalog only gates acquisition).
- `fetch-required` — the exact pack is absent and an explicit catalog entry
  exists.
- `stale-pack-present` — a same-name pack for a different version is cached;
  the exact pack is absent and a catalog entry exists.
- `partial-pack-present` — the exact pack is present but does not match the
  catalog baseline (missing files, changed metadata, or a divergent catalog
  entry such as a different id, integrity, included path, or upstream commit).
- `catalog-entry-missing` — the target is a known exact version but no catalog
  entry provides it.
- `resolution-unavailable` — the expected Effect identity cannot be resolved, or
  the declared specifier is not an exact version (for example a `^4.0.0` range
  from `package.json` after an unparseable or unsupported lockfile).

### `PackPlanStep`

```json
{
  "id": "pack-present",
  "title": "Reference pack already complete",
  "action": "already-complete",
  "detail": "… | null"
}
```

A single ordered, read-only step in an acquisition plan.

### `PackCatalog`

```json
{
  "name": "baseline",
  "baseline": "/path/to/catalog | null",
  "entries": [{ "id": "pack-effect-109", "…": "…" }]
}
```

An explicit catalog of `PackManifest` entries available for acquisition.
`baseline` records where the catalog came from so the source input is never
guessed. `loadPackCatalog(catalogDir)` reads every decodable
`<catalogDir>/<id>/manifest.json`; an unreadable or empty baseline yields an
empty catalog.

### `PackAcquisitionPlan`

```json
{
  "project": "/abs/project",
  "cacheDir": "/abs/cache",
  "resolution": { "…": "…" },
  "expected": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null } | null,
  "catalogEntry": { "id": "pack-effect-109", "…": "…" } | null,
  "localPack": { "id": "pack-effect-109", "…": "…" } | null,
  "verification": { "manifest": { "…": "…" }, "missingFiles": [], "metadataChanged": false, "stale": false, "message": null } | null,
  "action": "already-complete",
  "steps": [{ "id": "pack-present", "title": "Reference pack already complete", "action": "already-complete", "detail": null }],
  "diagnostics": [],
  "message": "… | null"
}
```

`planPackAcquisition({ projectDir, cacheDir, catalog })` runs the read-only
planning. Decision rules:

1. No target identity → `resolution-unavailable`.
2. Declared specifier is not an exact version → `resolution-unavailable`.
3. No exact catalog entry: an intact exact local pack is `already-complete`;
   otherwise `catalog-entry-missing` (plus a stale step only when the cached
   pack is genuinely a different version).
4. Exact catalog entry present: absent exact pack → `stale-pack-present` /
   `fetch-required`; present exact pack → `already-complete` when it matches the
   catalog baseline (via `verifyPack` against the selected entry), else
   `partial-pack-present`.

`selectCatalogEntry` is the documented catalog rule: an exact `samePackage`
(name and version) match only — never a range, compatible, or "any newer"
selection.

## `GuidanceIngestor` — src/GuidanceIngestor.ts

Read-only ingestion and normalization of guidance from verified local
reference packs. The ingestor reads a pack's included markdown files, parses
guidance blocks, and normalizes them into `Guidance` records with `Evidence`
that preserve the source path, the pack's upstream ref, and Effect version
applicability. It never fetches or mutates packs. Malformed blocks are surfaced
as `unvalidated`; contradictory blocks sharing a topic are surfaced as
`conflict`. Diagnostics and a per-ingest status let callers inspect what
happened instead of silently overwriting records.

### Entry points

- `ingestPackDir({ packDir })` — explicit pack directory input. Reads
  `manifest.json` from the directory, then ingests the pack's included files.
- `ingestPack({ cacheDir, manifest })` — exact verified local pack. Resolves
  `cacheDir/<manifest.id>`, reads the included files, and reports any that are
  missing. The caller supplies the manifest (e.g. from `PackVerifier.findPack`).

Both are read-only and produce a `GuidanceIngestResult`.

### `IngestStatus`

```json
"ok" | "partial" | "failed"
```

- `ok` — no diagnostics; every record is `validated`.
- `partial` — ingestion completed but produced diagnostics (malformed,
  conflicting, or missing-file records).
- `failed` — the pack manifest could not be read or parsed.

### `IngestDiagnosticSeverity`

```json
"info" | "warning" | "error"
```

### `IngestDiagnostic`

```json
{
  "file": "LLMS.md",
  "message": "guidance block has no summary",
  "severity": "warning",
  "topic": "Piping | null"
}
```

### `GuidanceIngestResult`

```json
{
  "pack": { "id": "pack-effect-109", "…": "…" } | null,
  "guidance": [],
  "diagnostics": [],
  "status": "ok"
}
```

### Supported input convention

A guidance item is a markdown block introduced by a heading. A level-1 heading
is treated as the document title and skipped; level-2 and deeper headings start
guidance blocks. The topic is the full heading path (e.g. `Piping > More
examples`), so repeated structural headings under different parents do not
collide. The first non-empty paragraph after the heading is the summary.
Optional metadata is a fenced code block
tagged `lens-guidance` placed after the summary, containing `key: value` lines.
For example:

````markdown
## Piping

Prefer `pipe` for composition.

```lens-guidance
applies-to: 4.0.0
ref: v4.0.0-rc.109
```
````

Supported metadata keys:

- `applies-to: <from>` or `applies-to: <from>..<to>` — version applicability
  window (`from` inclusive, `to` exclusive). Values must start with a numeric
  semver (`\d+\.\d+\.\d+`). Windows are compared semver-aware (a release is
  greater than any prerelease of the same core, so `4.0.0 > 4.0.0-rc.109`);
  an empty or inverted window (`from >= to`) is invalid.
- `ref: <ref>` — upstream ref override; defaults to the pack's upstream ref.

Defaults when metadata is absent:

- `source` — always `upstream` (pack material is upstream, never `lens-strict`).
- `appliesTo` — `{ from: <pack.effectVersion>, to: null }`.
- `upstreamRef` — the pack's `upstream`.

Each `Guidance` carries one `Evidence` per source file with `source` = the
pack-relative path, `ref` = the effective upstream ref, `location` =
`<file>:<heading line>`, `snippet` = the summary, and `attribution` = the
pack's `attribution` (when present) joined from its license/copyright/notice.
The record `id` includes the pack id, the pack-relative file path, the topic,
and the heading line, so ids are unique across files. The file path is encoded
non-lossily (`_` → `_u`, `/` → `_s`), so `foo/bar.md` and `foo-bar.md` never
collide. When a block overrides `ref`, the pack commit and source URL are
cleared so the evidence does not claim the override at the wrong commit.

### Validation and conflict visibility

- A block with no summary, or with an invalid `applies-to` window, is marked
  `unvalidated` with a `warning` diagnostic. The record is still produced (the
  summary falls back to the topic; the window falls back to the pack version)
  so callers can inspect it rather than losing it.
- Two blocks sharing a topic with different summaries are marked `conflict`
  with an `error` diagnostic when their version windows overlap. Only the
  specific overlapping contradictory pair is flagged; a disjoint sibling on the
  same topic is left `validated`. Same-topic blocks with non-overlapping
  windows are different guidance for different Effect versions and are not
  flagged. Records with an invalid (fallback) window or no summary do not
  participate in conflict detection. They are never silently merged.
- A missing or unreadable included file is reported as an `error` diagnostic
  and skipped.
- An included path that resolves outside the pack directory is rejected with
  an `error` diagnostic.
- An included directory is recursed for markdown files; a directory with no
  markdown files is reported with an `info` diagnostic.
- An unclosed code fence is reported with a `warning` diagnostic.
- A title-only file (no level-2+ headings) produces no records and an `info`
  diagnostic.

### Limitations

- This slice is read-only and local-only: it does not fetch packs, resolve
  remote refs, or run CLI commands. Remote acquisition is out of scope.
- Version strings are accepted by a numeric-semver prefix and compared
  semver-aware (prerelease identifiers included); full semver range semantics
  (e.g. `^`, `~`, `x` wildcards) are not enforced.
- Conflict detection is a same-topic/different-summary heuristic gated on
  overlapping version windows, not semantic contradiction analysis.
- Only the first paragraph after a heading is used as the summary; multi-line
  or structured guidance bodies are not yet normalized.
- This slice is Effect-pack-only: every record is `source: "upstream"`.
  Importing effect-solutions material (which must be labeled distinctly) is out
  of scope.

## Core operations — src/operations/

The adapter-independent read-only operations that CLI, pi, and future MCP
adapters consume. They centralize policy and analysis logic so no surface
adapter duplicates it. All operations are read-only and produce
JSON-serializable Schema-backed results. The shared version-applicability
logic lives in `src/Version.ts` and is used by ingestion, lookup, and design so
version decisions are computed identically everywhere.

### `VersionStatus` — src/operations/shared.ts

```json
"current" | "stale" | "unknown"
```

- `current` — the record's version window includes the active Effect version.
- `stale` — the record's version window does not include the active version.
- `unknown` — the record carries no version window, so applicability cannot be
  confirmed.

`versionStatusOf(guidance, effectVersion)` computes `{ applicable, versionStatus }`
for a guidance record. A record with no version window is treated as
inapplicable (`unknown`) so it is never silently used.

### `lookup` — src/operations/lookup.ts

Searches ingested guidance and returns compact, evidence-backed matches with
provenance and version applicability.

#### `LookupQuery`

```json
{
  "query": "piping",
  "effectVersion": "4.0.0",
  "limit": 10,
  "source": "upstream | null"
}
```

`query` is free text matched against guidance topics and summaries;
`effectVersion` is the project's active Effect version used to decide
applicability; `limit` (a positive integer) caps the returned matches; `source`
optionally restricts to a single source kind.

#### `LookupMatch`

```json
{
  "guidance": { "id": "g-pipe", "…": "…" },
  "score": 0.75,
  "applicable": true,
  "versionStatus": "current",
  "reason": "applies to effect 4.0.0 | null"
}
```

`score` is a deterministic relevance value (0..1): a query token found in the
topic scores 2, in the summary scores 1, over the maximum possible weight.
Matches are ranked by applicability first (applicable before inapplicable),
then by score descending, then by topic ascending, so current guidance is not
dropped when stale same-topic hits would otherwise fill the limit.

#### `LookupResult`

```json
{
  "query": "piping",
  "effectVersion": "4.0.0",
  "matches": [],
  "diagnostics": []
}
```

Diagnostics are emitted for incompatible (`stale`/`unknown`) references and
for `conflict` guidance, so incompatible versioned references are never
silently used. A query with no matches emits a `lookup-no-matches` diagnostic.

### `review` — src/operations/review.ts

Maps oxlint diagnostics to stable Lens `Finding` values and summarises them. It
reuses the existing rule catalog and the `toFinding` seam — it does not
duplicate rule policy. Diagnostics whose rule id is not in the Lens catalog are
never coerced into Lens findings; they are surfaced as non-rule `Diagnostic`
values.

#### `OxlintDiagnostic`

The Schema-backed counterpart of the `OxlintDiagnostic` interface in
`src/plugin/toFinding.ts`; the two MUST stay in sync.

```json
{
  "message": "Avoid async functions",
  "code": "lens(no-async-function)",
  "severity": "error | warning",
  "filename": "src/service.ts",
  "labels": [{ "span": { "line": 14, "column": 3 } | null }]
}
```

#### `ReviewInput`

```json
{ "diagnostics": [] }
```

#### `ReviewSummary`

```json
{ "total": 2, "errors": 1, "warnings": 1 }
```

#### `ReviewResult`

```json
{
  "findings": [],
  "diagnostics": [],
  "summary": { "total": 0, "errors": 0, "warnings": 0 },
  "status": 0
}
```

`status` is the aggregate `ExitStatus` derived from findings only: any `error`
→ `2`, else any `warning` → `1`, else `0`. Non-catalog diagnostics are `off`
notes and do not change the status.

### `design` — src/operations/design.ts

Combines supplied analysis facts with relevant guidance and returns an
advisory result with evidence and confidence. Design is advisory, never
authoritative.

#### `AnalysisFact`

```json
{
  "kind": "ast | type | state-pressure",
  "key": "pipe",
  "value": "pipe",
  "evidence": { "source": "…", "…": "…" } | null
}
```

`kind` is an open tag naming the analyzer that produced the fact; it is not a
closed enum, so new analyzers can introduce new kinds without changing this
contract. The operation is extensible for state-pressure analysis (issue #10):
a future state-pressure analyzer can supply facts with a distinct `kind`.

#### `DesignRequest`

```json
{
  "feature": "compose two services",
  "effectVersion": "4.0.0",
  "facts": [],
  "guidance": []
}
```

`guidance` is typically the output of a `lookup`.

#### `DesignAdvice`

```json
{
  "guidance": { "id": "g-pipe", "…": "…" },
  "confidence": 0.9,
  "applicable": true,
  "versionStatus": "current"
}
```

`confidence` is a deterministic value (0..1): base from the record's
validation status (`validated` 0.8, `unvalidated` 0.5, `conflict` 0.2), raised
by facts whose key matches the topic or whose value matches the summary (each
fact key and value counted at most once), and capped at 0.3 for `conflict`
guidance or when the record does not apply to the active Effect version.

#### `DesignResult`

```json
{
  "feature": "compose two services",
  "effectVersion": "4.0.0",
  "advice": [],
  "diagnostics": []
}
```

Advice is ranked by confidence descending, then topic ascending. Diagnostics
are emitted for incompatible (`stale`/`unknown`) references and for `conflict`
guidance, so incompatible versioned references are never silently used.

`designWithStatePressure` (see `statePressure`) merges the analyzer's
`state-pressure` facts into `design` and, when the analysis recommends a
machine, **prepends** an advisory `@typeonce/effect-machine` `DesignAdvice` to
the ranked advice. That advice is a deliberate, non-version-gated exception:
it carries `applicable: true` and `versionStatus: "unknown"` because it
concerns the workflow, not an Effect version window. It is surfaced by
prepending (it is the primary recommendation), not by the version-ranked
confidence sort, and it is `lens-advisory` — never a strict `lens-strict` rule.

### `drift` — src/operations/drift.ts

Builds a local {@link DriftReport} from the project's resolved Effect identity
and reference-pack verification. It maps each `ResolutionStatus` and
`PackStatus` to a `DriftKind` and records the local toolchain manifest. This is
the offline slice of drift detection: it reports the relationship between the
declared/installed Effect dependency and the available reference pack, but it
does not compare against live upstream tooling (the CLI surfaces that
limitation explicitly).

`buildDriftReport({ projectDir, cacheDir, lensVersion })` returns a
`DriftReport`. Each `DriftEntry` carries a `role` (`"dependency"` or `"pack"`)
so a dependency and a pack with the same kind and package name are not
conflated.

### `doctor` — src/operations/doctor.ts

Centralizes the error-vs-warning policy for the `doctor` surface.
`doctorDiagnostics({ projectDir, cacheDir })` resolves the Effect identity and
verifies the reference pack, then returns the resolution, the pack
verification, and the diagnostics that drive the exit code. A missing Effect
dependency is a blocking `error`; installed-mismatch, lockfile, and
reference-pack problems are advisory `warning`s.

### Operation limitations

- All operations are pure and read-only: they never mutate packs, guidance, or
  network state, and they do not fetch remote material.
- `lookup` relevance is a token-overlap heuristic, not semantic search.
- `design` confidence is a deterministic heuristic, not a calibrated model; it
  must not be presented as certainty.
- `review` maps only the initial Lens strict rule set; other oxlint diagnostics
  are surfaced as non-rule diagnostics rather than coerced into findings.
- `drift` is a local, offline slice; it does not compare against live upstream
  tooling.

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
  "role": "dependency | pack",
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

## `Hooks` — src/Hooks.ts

The read-only hook-manager status model used by `hooks status` and embedded in
the setup plan.

### `LensInstallStatus`

```json
"installed" | "absent" | "ambiguous"
```

`installed` — a present, readable manager config references `effect-lens`.
`absent` — no `effect-lens` reference found in a readable config. `ambiguous` —
a present config cannot be read, so the state cannot be determined.

### `HookManagerStatus`

```json
{
  "manager": "hk | husky | lefthook | pre-commit | lint-staged | simple-git-hooks",
  "present": true,
  "configPath": ".husky/pre-commit | null",
  "lensStatus": "installed | absent | ambiguous",
  "detail": "… | null"
}
```

### `HooksStatus`

```json
{
  "lensStatus": "installed | absent | ambiguous",
  "managers": [],
  "diagnostics": []
}
```

`lensStatus` is `installed` when any manager is installed, `ambiguous` when any
manager is ambiguous and none is installed, and `absent` otherwise.

## `HookMutation` — src/HookMutation.ts

The result model for the explicit `hooks install|uninstall` mutations (also
embedded in `SetupApplyResult`).

### `HookOperation`

```json
"install" | "uninstall"
```

### `HookMutationOutcome`

```json
"applied" | "noop" | "refused"
```

`applied` — the target was written or removed. `noop` — the requested state
already held; nothing was written. `refused` — the mutation was not performed
because the target was ambiguous or unsupported; nothing was written (never a
partial write).

### `HookMutationResult`

```json
{
  "operation": "install | uninstall",
  "manager": "hk | null",
  "targetPath": "hk.pkl | null",
  "outcome": "applied | noop | refused",
  "changed": true,
  "created": false,
  "detail": "… | null",
  "diagnostics": []
}
```

## `SetupApply` — src/SetupApply.ts

The result model for the explicit `setup --apply` mutation.

### `SetupApplyStepOutcome`

```json
"applied" | "ok" | "deferred" | "refused" | "skipped"
```

### `SetupApplyStep`

```json
{
  "id": "hooks",
  "title": "Install Lens hook checks",
  "status": "ok | needed | unsupported | skip",
  "outcome": "applied | ok | deferred | refused | skipped",
  "detail": "… | null"
}
```

### `SetupApplyResult`

```json
{
  "project": "/abs/path",
  "precondition": true,
  "steps": [],
  "hookMutation": { "…": "…" } | null,
  "diagnostics": []
}
```

`precondition` is `false` when the apply refused before any mutation because the
plan was not actionable. `hookMutation` reuses `HookMutationResult` for the
`hooks` step when it was attempted. `setup --apply` applies only the actionable
`hooks` step and reports every step; see [`docs/setup.md`](setup.md).

## `Setup` — src/Setup.ts

The read-only setup plan model used by `setup --dry-run`.

### `SetupStepStatus`

```json
"ok" | "needed" | "unsupported" | "skip"
```

### `SetupStep`

```json
{
  "id": "package-manager",
  "title": "Detect package manager",
  "status": "ok | needed | unsupported | skip",
  "detail": "… | null"
}
```

### `OxlintStatus`

```json
{
  "configPath": ".oxlintrc.json | null",
  "lensPluginConfigured": true,
  "status": "configured | missing | ambiguous"
}
```

### `SetupPlan`

```json
{
  "project": "/abs/path",
  "packageManager": "pnpm@11.20.0 | null",
  "effect": { "name": "effect", "version": "4.0.0-rc.109", "source": "lockfile", "integrity": null } | null,
  "resolution": { "…": "…" },
  "pack": { "…": "…" },
  "oxlint": { "…": "…" },
  "hooks": { "…": "…" },
  "steps": [],
  "diagnostics": []
}
```

`resolution` and `pack` reuse the shared `Resolution` and
`PackVerificationResult` contracts; `hooks` reuses `HooksStatus`. The plan is
read-only: it never writes config, dependencies, packs, or hooks. See
[`docs/setup.md`](setup.md) for the step semantics and supported hook managers.

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
`partial` / `complete` pack statuses. `test/GuidanceIngestor.test.ts` covers
positive, malformed, conflict (including a 3-block overlapping-window case),
version-window non-conflict, prerelease-aware overlap, default-rc overlap,
invalid-window exclusion, same-topic/same-summary non-conflict, heading
hierarchy, unique-id, path collision, path traversal, directory recursion,
unclosed-fence, attribution, ref-override, missing-manifest, and missing-file
ingestion against the committed cache fixtures and the `test/fixtures/ingest/`
packs.
