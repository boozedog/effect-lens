# Effect Lens core contracts

This document defines the stable internal data contracts shared by every Effect
Lens surface: the CLI, the pi extension, and the future MCP adapter. All models
live in `src/`, are defined with Effect `Schema`, and MUST NOT be redefined by
any consumer adapter.

Serialization is JSON. Each `Schema.Class` encodes to a plain JSON object with
`Schema.encodeSync` and decodes from JSON with `Schema.decodeUnknownSync`.
Optional fields are modelled with `Schema.OptionFromNullOr` and serialize to
`null` when absent and to their value when present.

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
