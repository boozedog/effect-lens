# Effect Lens core contracts

This document defines the stable internal data contracts shared by every Effect
Lens surface: the CLI, the pi extension, and the future MCP adapter. All models
live in `src/`, are defined with Effect `Schema`, and MUST NOT be redefined by
any consumer adapter.

Serialization is JSON. Each `Schema.Class` encodes to a plain JSON object with
`Schema.encodeSync` and decodes from JSON with `Schema.decodeUnknownSync`.
Optional fields are modelled with `Schema.OptionFromNullOr` and serialize to
`null` when absent and to their value when present.

## Rule provider seam — src/provider/

The unified `check` gate normalizes toolchain diagnostics through registered
rule providers. A provider owns a set of rule ids and normalizes a raw
diagnostic into a `ProviderDiagnostic` that carries provider identity and
provenance. The Lens strict rules are the first provider, followed by the
Foldstryx and StyleX first-party providers. All register through the same seam
without changing the `review` operation.

### `ProviderDiagnostic`

A normalized diagnostic with provider provenance.

```json
{
  "provider": "lens",
  "rule": "lens/no-async-function | null",
  "severity": "error | warning | off",
  "message": "Avoid async functions",
  "location": { "file": "src/service.ts", "line": 14, "column": 3, "snippet": null },
  "code": "lens(no-async-function)",
  "source": "lens-strict",
  "evidence": []
}
```

`provider` is the stable provider identity that produced the diagnostic;
`rule` is the provider's rule id when the diagnostic maps to a rule, or `null`
for a non-rule diagnostic. `source` and `evidence` are supplied by the provider
so a non-Lens provider can carry its own provenance and evidence without the
`review` operation re-deriving them from the Lens catalog.

### `RuleProvider`

```ts
interface RuleProvider {
  readonly id: string
  readonly title: string
  readonly ruleIds: ReadonlyArray<string>
  readonly recognizes: (code: string) => boolean
  readonly normalize: (diagnostic: RawDiagnostic, index: number) => ProviderDiagnostic | null
}
```

`recognizes` decides whether the provider owns a raw diagnostic `code`;
`normalize` converts a recognized raw diagnostic into a `ProviderDiagnostic`
(or `null` when it does not recognize it). `src/provider/lens.ts` exports the
`lensProvider`; `src/provider/foldstryx.ts` exports the `foldstryxProvider`;
`src/provider/stylex.ts` exports the `stylexProvider` and the supported
`stylexRuleIds` catalog;
`src/provider/registry.ts` exports `ProviderRegistry` (which resolves a raw
diagnostic to the first provider that recognizes it) and `defaultRegistry`
(the Lens, Foldstryx, and StyleX providers registered).

### `CheckMode`

```json
"lens-only" | "unified"
```

- `lens-only` (default) — preserves the existing single-package Lens behavior:
  a fresh scratch config loads the Lens rules, and unrecognized diagnostics are
  advisory `off` notes.
- `unified` — a config-preserving gate: the target repository's oxlint config
  (ignores, overrides, rule settings) is preserved while the Lens rules are
  loaded, and unrecognized project diagnostics are surfaced as visible
  diagnostics with their raw oxlint severity.

### Foldstryx provider and rule equivalence

The Foldstryx provider (`src/provider/foldstryx.ts`) recognizes the supported
`foldstryx(...)` diagnostic codes and normalizes them with
`provider: "foldstryx"` provenance. It never requires Foldstryx to be
installed: it only recognizes diagnostic codes, so single-project Lens use is
unaffected.

The explicit Foldstryx → Lens rule-equivalence mapping lives in
`src/provider/equivalence.ts` (`foldstryxEquivalences`). Each supported
Foldstryx rule maps to the canonical Lens rule that enforces the same
Effect-first policy:

| Foldstryx rule                  | Canonical Lens rule        |
| ------------------------------- | -------------------------- |
| `foldstryx/no-async-function`   | `lens/no-async-function`   |
| `foldstryx/no-await-expression` | `lens/no-await-expression` |
| `foldstryx/no-new-promise`      | `lens/no-new-promise`      |

A supported Foldstryx diagnostic is normalized toward its canonical Lens rule:
the normalized `ProviderDiagnostic` carries the canonical Lens rule id, source
kind, and catalog evidence, so the `review` operation can compare it directly
with a Lens diagnostic. The `provider: "foldstryx"` field preserves the
Foldstryx provenance. A Foldstryx rule with no Lens equivalent is not
recognized by the provider and is surfaced as an unrecognized diagnostic rather
than being coerced into a Lens rule.

### StyleX provider and supported rule catalog

The StyleX provider (`src/provider/stylex.ts`) recognizes the supported
`stylex(...)` diagnostic codes and normalizes them with
`provider: "stylex"` provenance and `source: "project"` classification. It
never requires StyleX to be installed: it only recognizes diagnostic codes, so
ordinary Lens-only projects are unaffected.

The provider owns an explicit supported StyleX rule catalog
(`stylexRuleIds`) — the official `@stylexjs/eslint-plugin` rule ids as of
plugin version `0.19.0`:

| StyleX rule                          |
| ------------------------------------ |
| `stylex/valid-styles`                |
| `stylex/valid-shorthands`            |
| `stylex/no-unused`                   |
| `stylex/no-legacy-contextual-styles` |
| `stylex/no-conflicting-props`        |
| `stylex/no-nonstandard-styles`       |
| `stylex/no-lookahead-selectors`      |
| `stylex/sort-keys`                   |
| `stylex/enforce-extension`           |

Unlike Foldstryx, StyleX rules have no canonical Lens equivalent: they enforce
StyleX style policy, not Effect-first policy. A supported StyleX diagnostic is
therefore normalized to its own StyleX rule id with `source: "project"` and
StyleX plugin evidence, so the `review` operation keeps it as a distinct
finding rather than coercing it into a Lens rule or a migration entry. A StyleX
rule outside the catalog is not trusted blindly — it is not recognized by the
provider and is surfaced as an unrecognized diagnostic.

Oxlint reports these rules as `stylex(<rule>)` codes (the plugin is loaded
under the `stylex` alias), which the provider maps to the `stylex/<rule>` ids
above. The official ESLint ids are `@stylexjs/<rule>`; the provider recognizes
the oxlint `stylex(<rule>)` form, not the `@stylexjs(...)` form. A rule added
in a later plugin version is not in the catalog and stays unrecognized until
the catalog is extended.

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
- **Source kind** (`"upstream" | "lens-strict" | "lens-advisory" | "project"`) records
  whether guidance or a finding reflects upstream Effect practice, Lens strict
  policy, Lens advisory design analysis, or a first-party project rule. Lens strict-policy rules are never
  presented as unqualified upstream authority, and advisory design
  recommendations (e.g. `@typeonce/effect-machine`) are never presented as
  strict rules or as upstream Effect guidance. A first-party project rule (e.g.
  StyleX) with no Lens or upstream Effect equivalent is classified as `project`
  so it is never mislabeled as upstream Effect guidance or Lens strict policy.
- **Every finding carries** its rule id, severity, source kind, version
  applicability, location, and evidence. There is no bare "text match" finding.

## `Provenance` — src/Provenance.ts

### `SourceKind`

Literal union. Values:

```json
"upstream" | "lens-strict" | "lens-advisory" | "project"
```

`lens-advisory` marks advisory design recommendations (see `statePressure`). It
is additive and backward-compatible: existing `"upstream"` and `"lens-strict"`
values still decode, and no exhaustive `src/` switch breaks. `project` marks a
first-party project rule (e.g. StyleX) that has no Lens or upstream Effect
equivalent; it is additive and backward-compatible for the same reason.

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
"package.json" | "lockfile" | "installed" | "registry"
```

`lockfile` is preferred for reproducibility; `installed` reflects disk state;
`registry` marks a candidate version observed from a registry snapshot (used by
the read-only freshness recommendation, never a project dependency).

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
  "provider": "lens | null",
  "severity": "error",
  "source": "lens-strict",
  "message": "Prefer Effect composition.",
  "appliesTo": { "from": "4.0.0", "to": null } | null,
  "location": { "file": "src/service.ts", "line": 14, "column": 3, "snippet": null },
  "evidence": [],
  "waivers": []
}
```

`provider` is the stable provider identity that produced the finding (`"lens"`
for the Lens provider, `"foldstryx"` for the Foldstryx provider, `"stylex"`
for the StyleX provider). The key is always present in encoded output
(`makeFinding` defaults it to `"lens"`); it decodes as `null` for legacy values
that predate the field.

### `Diagnostic`

A non-rule diagnostic (toolchain or resolution problem). Same shape as a finding
minus evidence/waivers/rule/provider.

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
"resolved" | "installed-mismatch" | "missing-lockfile" | "unsupported-lockfile" | "missing" | "workspace-ambiguous" | "workspace-unresolved"
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
- `workspace-ambiguous` — a requested workspace target matches more than one
  lockfile importer.
- `workspace-unresolved` — a requested workspace target matches no supported
  lockfile importer.

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

In a monorepo, the repository root is the lockfile/configuration boundary. An
optional `workspace` target selects the package to resolve: the expected
identity comes first from the target's matching root-lockfile importer (the
root importer when no target is given), then from the target's `package.json`
(when targeted) or the root `package.json`. A target that matches no single
importer is reported as `workspace-ambiguous` or `workspace-unresolved` and
never falls back to a guessed manifest. See `docs/cli.md` for the target
selection rules.

`resolveWorkspaceTarget(projectDir, workspace)` exposes the same matching as a
three-way result that callers use to reject a bad target before doing work:
`{ kind: "ok", dir }` (the canonical repo-relative importer path, with a
basename target expanded to the full path), `{ kind: "ambiguous", detail }`
(more than one importer matches), or `{ kind: "unresolved", detail }` (no
importer matches). `check` and `hooks install` / `setup --apply` use it to
reject invalid or ambiguous targets before any lint run or hook write.

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
commands. Network acquisition and atomic promotion are the explicit
`PackAcquire` executor (below), never a side effect of planning.

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

## `PackStatus` — src/PackStatus.ts

Read-only baseline/status reporting for Lens-managed reference packs. It layers
the explicit catalog baseline on top of the resolver and verifier so a target
can answer the question issue #15 depends on: "does this project's exact target
Effect version have a verified matching pack, and what baseline/candidate does
the explicit catalog offer?" It is strictly read-only: it never fetches,
writes, deletes, or updates cache files, and it never applies a remote,
release-age, or channel policy.

### `PackBaselineStatus`

```json
["unresolved", "absent", "stale", "corrupt", "complete", "mismatched", "verified"]
```

- `unresolved` — no exact target Effect identity could be derived (no declared
  dependency, a range specifier, or a failed workspace target).
- `absent` — no reference pack exists for the package at all.
- `stale` — a cached pack is for a different Effect version; the exact pack is
  absent.
- `corrupt` — the exact pack is present but self-inconsistent (missing its own
  declared files).
- `complete` — the exact pack is present and self-consistent, but no catalog
  baseline entry exists to verify it against (presence beats source).
- `mismatched` — the exact pack is present and self-consistent but diverges
  from the catalog baseline.
- `verified` — the exact pack is present, self-consistent, and matches the
  catalog baseline.

### `PackStatusReport`

```json
{
  "project": "/abs/project",
  "cacheDir": "/abs/cache",
  "workspace": "packages/foldkit | null",
  "resolution": { "…": "…" },
  "expected": { "name": "effect", "version": "4.0.0-beta.83", "source": "lockfile", "integrity": null } | null,
  "localPack": { "id": "pack-effect-beta83", "…": "…" } | null,
  "catalogEntry": { "id": "pack-effect-beta83", "…": "…" } | null,
  "localVerification": { "manifest": { "…": "…" }, "missingFiles": [], "metadataChanged": false, "stale": false, "message": null } | null,
  "baselineVerification": { "manifest": { "…": "…" }, "missingFiles": [], "metadataChanged": false, "stale": false, "message": null } | null,
  "candidateBaselines": [{ "id": "pack-effect-109", "…": "…" }],
  "status": "verified",
  "diagnostics": [],
  "message": "reference pack pack-effect-beta83 is verified against the catalog baseline | null"
}
```

`reportPackStatus({ projectDir, cacheDir, catalog, workspace? })` returns the
report. Decision rules:

1. No exact target identity (no dependency, range specifier, or failed
   workspace target) → `unresolved`.
2. No pack for the package → `absent`; a cached different-version pack →
   `stale`.
3. Exact pack present but missing its own declared files → `corrupt`.
4. Exact pack present and self-consistent: with no catalog baseline entry →
   `complete`; with a matching entry → `verified`; with a divergent entry →
   `mismatched`.

The baseline comparison (`baselineVerification`) is `verifyPack` against the
selected catalog entry directly, so a changed on-disk manifest, a missing
baseline file, or a different upstream ref/integrity/included-path set relative
to the catalog is reported as `mismatched`. `candidateBaselines` are the
catalog entries for the same package name that are not the exact match, sorted
deterministically by id and reported as read-only availability only — no
release-age, channel, or ordering policy is applied here.

## `Freshness` — src/Freshness.ts

Read-only freshness recommendation for a project's Effect dependency (issue
#15). It answers: "given the project's installed/declared Effect version and an
explicit registry snapshot, what is the newest Effect release allowed by the
channel and release-age/cooldown policy, and does a reference pack exist for
it?" It is the network-backed counterpart to the offline `drift`/`packs status`
slices: it consumes an explicit, injectable registry snapshot and never
performs network I/O itself. It is strictly read-only and advisory — it never
mutates package manifests, lockfiles, or pack caches, and it never selects a
reference pack implicitly (a missing candidate pack is reported as an
actionable `catalog-missing` / `not-cached` result, not fetched). Dependency
mutation is left to Nub.

### `Channel`

```json
"alpha" | "beta" | "rc" | "stable" | "other"
```

The prerelease maturity channel of an Effect version. `stable` is a release
with no prerelease; `other` is a prerelease whose first identifier is not a
known channel. `channelOf(version)` and `channelOfSpecifier(specifier)`
classify exact versions and declared specifiers (including ranges).

### `ChannelPolicy`

```ts
interface ChannelPolicy {
  readonly allowedTargets: (declared: Channel) => ReadonlyArray<Channel>
}
```

Decides which prerelease channels a project may move to. The default
`defaultChannelPolicy` is the "more mature" rule: a project may move to any
channel at or after its declared channel in `alpha < beta < rc < stable` order.
A beta project MAY be recommended an RC, but only because the policy explicitly
permits it — a beta range is never assumed to include an RC. The policy is
injectable so a stricter rule (e.g. same-channel-only) can be tested.

### `CooldownPolicy`

```ts
interface CooldownPolicy {
  readonly minAgeDays: number
  readonly perChannel?: Partial<Record<Channel, number>>
}
```

The release-age/cooldown policy. `minAgeDays` is the minimum age (in days) a
candidate must have before it is recommended; `perChannel` optionally overrides
it for a specific channel. The default is `{ minAgeDays: 0 }` (no cooldown);
projects opt in via `--cooldown-days` or an injected policy.

### `RegistryVersion` and `RegistrySnapshot`

```json
{
  "name": "effect",
  "distTags": { "rc": "4.0.0-rc.109" },
  "versions": [{ "version": "4.0.0-rc.109", "publishedAt": "2026-01-10T00:00:00.000Z | null" }]
}
```

An explicit, injectable snapshot of a package's registry state: the dist-tags
(informational) and every version with its publish timestamp. This is the ONLY
place the recommendation learns about available versions; it never invents a
version or consults a remote itself. `src/RegistryClient.ts` provides the
injectable `RegistryClient` interface and an `npmRegistryClient` that fetches
this snapshot from the npm registry with Node's global `fetch` (never `npm`).

### `CooldownResult`

```json
{
  "allowed": true,
  "minAgeDays": 0,
  "ageDays": 200.0 | null,
  "publishedAt": "2026-01-10T00:00:00.000Z | null",
  "reason": "candidate is 200.0 days old (min 0) | null"
}
```

The result of applying the cooldown policy to a candidate.

### `CandidatePackStatus`

```json
"available" | "not-cached" | "catalog-missing" | "unknown"
```

The reference-pack availability for a recommended candidate. `available` — a
catalog entry exists and its pack is cached and verified; `not-cached` — a
catalog entry exists but the pack is not cached/verified; `catalog-missing` —
no catalog entry provides the candidate version; `unknown` — no catalog was
provided.

### `FreshnessStatus`

```json
"unresolved" | "network-error" | "up-to-date" | "recommendation" | "cooldown" | "no-candidate"
```

- `unresolved` — no exact installed Effect version could be derived.
- `network-error` — the registry snapshot could not be fetched.
- `up-to-date` — the installed version is the newest allowed candidate.
- `recommendation` — a newer allowed candidate exists and passes cooldown.
- `cooldown` — a newer allowed candidate exists but fails the cooldown.
- `no-candidate` — no newer allowed candidate could be selected.

### `FreshnessRecommendation`

```json
{
  "project": "/abs/project",
  "cacheDir": "/abs/cache",
  "workspace": "packages/foldkit | null",
  "resolution": { "…": "…" },
  "installed": { "name": "effect", "version": "4.0.0-beta.83", "source": "installed", "integrity": null } | null,
  "declaredSpecifier": "4.0.0-beta.83 | null",
  "channel": "beta | null",
  "candidate": { "name": "effect", "version": "4.0.0-rc.109", "source": "registry", "integrity": null } | null,
  "candidatePublishedAt": "2026-01-10T00:00:00.000Z | null",
  "cooldown": { "allowed": true, "…": "…" } | null,
  "packStatus": "catalog-missing | null",
  "packId": "pack-effect-109 | null",
  "excluded": [],
  "status": "recommendation",
  "diagnostics": [],
  "message": "recommend upgrading effect 4.0.0-beta.83 to 4.0.0-rc.109 | null"
}
```

`computeFreshnessRecommendation({ project, cacheDir, resolution, registry,
channelPolicy?, cooldownPolicy?, excludedVersions?, now?, catalog? })` computes
the recommendation from an explicit registry snapshot and the policy. Decision
rules:

1. No exact installed version → `unresolved`.
2. No newer allowed candidate: installed is the newest allowed version →
   `up-to-date`; otherwise → `no-candidate`.
3. A newer allowed candidate exists: cooldown passes → `recommendation`;
   cooldown fails → `cooldown`.

Candidate selection filters registry versions to the allowed channels, drops
excluded versions, keeps only versions newer than the installed version, and
picks the newest by semver. The candidate's reference-pack status is computed
from the explicit catalog and the on-disk cache (read-only).

`src/operations/freshness.ts` exposes `buildFreshnessRecommendation`, an Effect
program that resolves the project identity, fetches the registry snapshot via
an injected `RegistryClient`, and maps a fetch failure to a `network-error`
recommendation (the effect never fails).

## `PackAcquire` — src/PackAcquire.ts

Explicit reference-pack acquisition with verification and atomic cache
promotion. This is the mutating counterpart to the read-only `PackPlan`
planner: given an explicit, exact catalog entry and an injected transport, it
verifies the fetched artifact and atomically promotes a complete pack into the
cache. Acquisition is NEVER implicit — only the explicit `packs fetch` CLI
command invokes it (via the `PackTransport` boundary); no plan, doctor, drift,
lookup, or guidance-ingestion path does, and it performs no network I/O itself.

### `AcquirePackAction`

```json
["acquired", "already-present", "refused", "failed"]
```

- `acquired` — the artifact was fetched, verified, and atomically promoted.
- `already-present` — an exact, complete pack is already cached; nothing was
  written and the transport was not invoked.
- `refused` — a deterministic precondition/validation failure (missing source
  URL, identity/version/integrity mismatch, missing file, traversal/symlink
  escape, or a divergent existing pack without an explicit replace). Nothing
  was written.
- `failed` — an unexpected transport or filesystem error. Nothing was written
  to the final pack directory.

### `AcquirePackResult`

```json
{
  "cacheDir": "/abs/cache",
  "entry": { "id": "pack-effect-109", "…": "…" },
  "action": "acquired",
  "manifest": { "id": "pack-effect-109", "…": "…" } | null,
  "verification": { "manifest": { "…": "…" }, "missingFiles": [], "metadataChanged": false, "stale": false, "message": null } | null,
  "diagnostics": [],
  "message": "acquired reference pack pack-effect-109 | null"
}
```

Diagnostics NEVER contain credentials, remote response bodies, or arbitrary
fetched content.

### The transport boundary

`acquirePack({ cacheDir, catalogEntry, transport, replace? })` takes a narrow,
documented, synchronous transport:

```ts
type PackArtifactTransport = (
  entry: PackManifest
) => { ok: true; stagedDir: string } | { ok: false; reason: string }
```

The transport receives the catalog entry (the ONLY source of the artifact's
URL) and returns either a local staging directory containing the fetched
artifact (including a decodable `manifest.json`) or a refusal. The executor
performs no network I/O and is fully testable offline. Real network adapters
stage the artifact to a temp directory before invoking `acquirePack`. No other
command or operation uses a transport.

### Validation and promotion

`acquirePack` rejects (returns `refused`, writing nothing) when:

- the catalog entry has no explicit `sourceUrl`;
- the staged `manifest.json` is missing/undecodable, its `id` differs, its
  package identity is not the exact name+version match, or its included paths
  differ from the catalog;
- an included path escapes the staged root (`..`, absolute, or a symlink to an
  outside directory) or is not a regular non-symlink file;
- an included file is absent (content completeness);
- the declared `integrity` (SRI `sha256`/`sha512` over framed per-file input —
  `path \0 uint64le(len) \0 <bytes>` for each file in catalog order, so
  re-slicing file boundaries cannot collide) does not match, or its algorithm
  is not `sha256`/`sha512`;
- the catalog entry `id` is not a single safe path segment (no separators,
  no `..`, no absolute path), so `cacheDir/<id>` can never escape the cache.

It preserves an existing complete pack (`already-present`, transport not
invoked) and refuses a divergent existing pack unless `replace: true` is set.
Replacement is safe: the divergent directory is moved aside before the atomic
rename and restored on failure. A pack is only treated as complete when its
stored `manifest.json` is decodable and matches the catalog, so a missing or
corrupt manifest is never silently accepted.

Promotion is atomic: the validated files plus a final manifest (preserving the
catalog's upstream ref, source URL, integrity, included paths, and attribution)
are copied into an executor-owned temp directory under `cacheDir`, and that
complete directory is then renamed into `cacheDir/<packId>`. The final pack
directory appears only via that single rename, so a refused or failed attempt
never leaves a partial pack and multiple pack IDs / Effect versions stay
isolated.

### Remaining work (not in this slice)

- A real network (HTTP) transport adapter that stages an artifact before calling
  `acquirePack`. The transport boundary is injectable, so this can be added
  without changing the executor.
- Detecting content drift of an already-cached pack (hashing existing pack
  contents), which the read-only verifier does not do today.
- `pin` / catalog-update workflows and `replace` policy surfacing beyond the
  explicit `--replace` flag.

## `PackTransport` — src/PackTransport.ts

The explicit pack artifact transport for reference-pack acquisition. It
defines exactly ONE supported artifact format for this slice: a local
directory (the "source") containing the pack's included files plus a decodable
`manifest.json`. The catalog entry's `sourceUrl` points at that directory,
either as a `file://` URL or as a plain filesystem path. The transport stages
the directory into a temporary location and returns it to `acquirePack`; it
never mutates the source and performs no network I/O.

### The transport boundary

`stageLocalDirectory(entry)` returns the narrow, synchronous transport result:

```ts
type TransportResult =
  | { ok: true; stagedDir: string }
  | { ok: false; reason: string }
```

`localDirectoryTransport()` builds a `PackArtifactTransport` (the
`PackAcquire` boundary) that calls `stageLocalDirectory`. The transport is
injectable, so tests exercise success and failure without any live network.

### Artifact format (this slice)

- The source is a single local directory addressed by the catalog entry's
  `sourceUrl` (`file://` URL or plain path).
- A `file://` URL is converted with `fileURLToPath`; a URL with any other scheme
  (for example `https://`) is refused as unsupported. A plain path is resolved
  against the current working directory, so catalogs SHOULD use absolute
  `file://` URLs to avoid depending on the invocation directory.
- It contains the pack's included files (as listed in `includedPaths`) plus a
  `manifest.json` that decodes to a `PackManifest` matching the catalog entry
  (same `id`, exact package name+version, same `includedPaths`).
- The transport copies the directory into a fresh temp directory (preserving
  symlinks as symlinks so the executor's path-traversal/symlink checks still
  apply) and returns it as the staged artifact.
- No tarball/archive or remote (HTTP) format is supported in this slice; the
  transport boundary is narrow and injectable so a network adapter can be
  added later without changing the executor.

### Failure behavior

`stageLocalDirectory` refuses (returns `{ ok: false, reason }`) when the
`sourceUrl` is missing, unsupported, or points at a missing or non-directory
path. Reasons are short and non-secret; the transport never prints credentials,
remote response bodies, or arbitrary fetched content. The executor surfaces a
refusal as a `failed` acquisition with the `acq-transport-failed` diagnostic.

### Offline boundary

The transport is only ever invoked through an explicit call to
`acquirePack` (via the `packs fetch` CLI command). No other command, plan,
doctor, drift, lookup, or guidance-ingestion path invokes a transport, so
`doctor`, `drift`, `lookup`, guidance ingestion, and planning remain offline
and read-only.

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
normalizes each raw diagnostic through the registered rule providers (the Lens
strict rules are the first provider, followed by the Foldstryx and StyleX
first-party providers) and maps the normalized diagnostics to stable `Finding` values.
Equivalent Lens and Foldstryx diagnostics that refer to the same canonical rule
and location collapse to a single finding; the redundant Foldstryx diagnostic
becomes a migration diagnostic plus a `MigrationReport` entry. Diagnostics that
no provider recognizes are never coerced into Lens findings; they are surfaced
as non-rule `Diagnostic` values.

StyleX diagnostics have no Lens equivalent, so they are kept as distinct
findings with `provider: "stylex"` provenance and `source: "project"`
classification, and never produce a migration entry.

`review` accepts an optional `mode` (`lens-only` default | `unified`) and an
optional `providers` list. In `lens-only` mode unrecognized diagnostics are
advisory `off` notes; in `unified` mode they are surfaced as visible
diagnostics with their raw oxlint severity (an `error` project rule stays
blocking, a `warning` stays advisory) so unknown project diagnostics are never
silently dropped.

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
  "migration": { "entries": [] },
  "status": 0
}
```

`status` is the aggregate `ExitStatus` derived from findings only: any `error`
→ `2`, else any `warning` → `1`, else `0`. Non-catalog diagnostics are `off`
notes in `lens-only` mode and do not change the status; in `unified` mode they
are surfaced with their raw severity and the caller's `aggregateStatus` (see
`ExitStatus`) reflects them in the exit code.

#### `MigrationEntry` and `MigrationReport`

The `migration` field of `ReviewResult` is the migration report: the redundant
first-party provider rules observed in a review and the canonical Lens rule each
should be replaced with. It is read-only and advisory — it never mutates config.

```json
{
  "providerRule": "foldstryx/no-async-function",
  "canonicalRule": "lens/no-async-function",
  "count": 2,
  "recommendation": "Replace foldstryx/no-async-function with lens/no-async-function; Lens enforces the same rule with catalog evidence."
}
```

`count` is the number of overlapping locations observed for that rule pair.
Each redundant Foldstryx diagnostic is also surfaced as a `warning` migration
`Diagnostic` (id `review-migration-*`) that names the redundant rule, the
canonical Lens rule, and the location, so the overlap and migration path stay
explainable. A Foldstryx diagnostic at a location with no equivalent Lens
finding is kept as a finding with `provider: "foldstryx"` provenance so it is
never silently dropped.

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

When `hooks install` receives a `--workspace` target, the target is validated
against the root lockfile importers **before any file write**. A target that
matches no importer or more than one importer is `refused` with a blocking
`hooks-install-hk-workspace-unresolved` / `hooks-install-hk-workspace-ambiguous`
`error` diagnostic and nothing is written (never a partial write). A valid
target is canonicalized to the full importer path for the generated command.

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

## `Adoption` — src/Adoption.ts

The read-only staged-adoption audit model used by `adoption audit` (issue
#14). It is the first phase of the staged Foldstryx adoption path: it inspects
the target's Effect resolution, reference-pack state, oxlint configuration and
scopes, active providers and rules, equivalent-rule overlaps, and the current
unified-gate findings, and returns actionable migration recommendations. The
audit is strictly read-only and offline.

### `OxlintScopes`

The detected oxlint configuration scopes, read verbatim and never rewritten.

```json
{
  "configPath": ".oxlintrc.json | null",
  "ignorePatterns": ["scripts/**"],
  "overrides": [],
  "rules": { "foldstryx/no-async-function": "error" }
}
```

### `ProviderStatus`

The status of a single rule provider in the audit.

```json
{
  "provider": "foldstryx",
  "title": "Foldstryx rules",
  "active": true,
  "rules": ["foldstryx/no-async-function"]
}
```

`active` is true when the provider is loaded by the project's oxlint config (a
matching `jsPlugins` entry or a configured rule). The Lens provider always
reports its catalog rule ids so the audit shows the canonical rules available
even when not configured.

### `RuleOverlap`

An equivalent-rule overlap between a first-party provider rule and the
canonical Lens rule it duplicates, derived from the explicit
`foldstryxEquivalences` mapping and the project's configured rules.

```json
{
  "providerRule": "foldstryx/no-async-function",
  "canonicalRule": "lens/no-async-function",
  "rationale": "Foldstryx bans async functions; Lens enforces the same Effect-first rule."
}
```

### `GateFindings`

The current unified-gate findings for the audited project.

```json
{
  "findings": [
    { "rule": "lens/no-async-function", "provider": "lens", "severity": "error", "…": "…" }
  ],
  "migration": [
    {
      "providerRule": "foldstryx/no-async-function",
      "canonicalRule": "lens/no-async-function",
      "count": 1,
      "recommendation": "…"
    }
  ],
  "diagnostics": [],
  "summary": { "total": 1, "errors": 1, "warnings": 0 },
  "status": 2,
  "error": null,
  "degraded": false,
  "failure": null
}
```

`findings` are the aggregated `Finding` values from a unified-mode review
(encoded with the shared `Finding` contract, so optionals serialize to
`null`/value); `migration` is the read-only migration report of redundant
first-party rules; `diagnostics` are the non-rule diagnostics (including
unrecognized project diagnostics and per-location migration notes); `summary`
counts findings by severity; `status` is the aggregate exit status. When oxlint
is unavailable, `error` carries the reason, `failure` carries the bounded
subprocess metadata, and the other fields are empty. When the project's
oxlint config could not be parsed and oxlint fell back to the
built-in config, `degraded` is `true` so the findings are not mistaken for the
project's own policy.

### `OxlintFailure`

Bounded, deterministic metadata describing an oxlint unified-gate failure
(configuration/plugin/tool trouble) so the gate is visibly unavailable rather
than an empty clean result. It is present only when the subprocess failed to
start, produced no JSON output, or produced unparseable output — never for a
normal lint run with valid JSON diagnostics, even one that exits non-zero.

```json
{
  "kind": "empty-output | no-binary | config-write | startup | unparseable",
  "message": "oxlint produced no JSON output (exit 1): Failed to load JS plugin: ./missing-plugin.ts …",
  "status": 1,
  "signal": null,
  "stderr": "",
  "stdout": "Failed to load JS plugin: ./missing-plugin.ts\nCannot find module …"
}
```

`kind` is the stable failure class. `message` is a concise human-readable
summary that also feeds the gate `error` string and the
`adoption-gate-unavailable` / `check-oxlint-unavailable` diagnostics. `status`
is the subprocess exit code and `signal` the terminating signal; both are
`null` for pre-spawn failures (no binary, config write). `stderr`/`stdout` are
bounded excerpts (capped, with a truncation marker) so a config/plugin failure
is actionable without dumping unbounded subprocess output. Post-spawn captures
are `""` when a stream is empty (`null` is reserved for pre-spawn failures).
The human `message` embeds the bounded stderr excerpt when present, otherwise
the bounded stdout excerpt — oxlint 1.78 prints plugin/config load failures to
stdout with empty stderr, so a stderr-only message would hide the cause.

### `Recommendation`

An actionable migration recommendation.

```json
{
  "kind": "migrate-overlap",
  "message": "Migrate foldstryx/no-async-function to lens/no-async-function; Lens enforces the same rule with catalog evidence.",
  "detail": "… | null"
}
```

`kind` is one of `migrate-overlap`, `configure-lens`, `fetch-pack`, or
`resolve-dependency`. Recommendations are advisory and never mutate config.

### `AdoptionAudit`

```json
{
  "project": "/abs/path",
  "workspace": "packages/foldkit | null",
  "resolution": { "…": "…" },
  "pack": { "…": "…" },
  "oxlint": { "…": "…" },
  "oxlintScopes": { "…": "…" },
  "providers": [],
  "overlaps": [],
  "gate": { "…": "…" },
  "recommendations": [],
  "diagnostics": []
}
```

`resolution` and `pack` reuse the shared `Resolution` and
`PackVerificationResult` contracts; `oxlint` reuses `OxlintStatus`. The audit
is read-only and offline: it never mutates source, configs, packs,
dependencies, or hooks, never removes Foldstryx rules, and never creates
waivers. Freshness lookup is a separate network-backed surface (`freshness`).

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

## Packed-artifact consumer E2E (issue #17)

`nub run pack:check` (`scripts/package-check.mjs`) proves the packed
`effect-lens` artifact is self-contained and runnable from a clean
workspace-style consumer outside the repository, without a source checkout and
without a globally installed Nub at runtime. It never publishes to a registry.
The workspace consumer exercises the real integration paths against the packed
CLI:

- **Root lockfile + workspace importer resolution** — `doctor` resolves the
  root importer (`4.0.0-rc.109`) and a selected `--workspace packages/app`
  importer (which pins a distinct `4.0.0-beta.83`) from the consumer's root
  `pnpm-lock.yaml`, so the workspace assertion can only pass if the selected
  importer was actually consulted rather than falling back to the root.
- **Invalid / ambiguous workspace targets** — a full `check` with an
  unresolved or ambiguous target is rejected with exit `2` and an actionable
  diagnostic (never a silent root scan or a fabricated clean result).
- **Consumer config/plugin path** — a full `check --mode unified
  --workspace packages/app` loads the consumer's own `.oxlintrc.json` and a
  deterministic plugin fixture, reports the Lens finding with `(lens)` provider
  provenance (and `"provider": "lens"` in the `--json` payload), and excludes
  an outside-workspace root violation.
- **Staged changed-file scope** — `check --mode unified --workspace
  packages/app --changed` lints only the selected workspace's staged files and
  honors the consumer config ignores.
- **Actionable config/plugin failure** — a broken plugin surfaces
  `exit 1` / `Failed to load JS plugin` metadata and a
  `check-oxlint-unavailable` diagnostic, never a clean empty gate.
- **Hook install** — `hooks install --workspace packages/app` discovers the
  local packed binary and generates an hk command that includes the unified
  changed scope and the selected workspace; the script then extracts the
  written `["effect-lens"]` step's `check` command and spawns it from the
  consumer cwd, asserting it runs the unified changed-scope check.

All temporary consumer directories and the tarball are removed in a `finally`
block on both success and failure, and the script verifies they are gone before
exiting.
