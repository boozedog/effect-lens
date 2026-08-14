import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import * as Drift from "../src/Drift.ts"
import * as ExitStatus from "../src/ExitStatus.ts"
import * as Finding from "../src/Finding.ts"
import * as Guidance from "../src/Guidance.ts"
import * as GuidanceIngestor from "../src/GuidanceIngestor.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackVerifier from "../src/PackVerifier.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"
import * as Resolver from "../src/Resolver.ts"
import * as Rule from "../src/Rule.ts"

const effect109 = PackageIdentity.makePackageIdentity({
  name: "effect",
  version: "4.0.0-rc.109",
  source: "lockfile",
  integrity: "sha512-deadbeef"
})

const upstream = Provenance.makeUpstreamRef({
  repository: "effect-ts/effect",
  ref: "v4.0.0-rc.109",
  commit: "deadbeef"
})

const finding = Finding.makeFinding({
  id: "f-1",
  rule: "lens/no-async-function",
  severity: "error",
  source: "lens-strict",
  message: "Prefer Effect composition.",
  location: Finding.makeLocation({ file: "src/a.ts", line: 1 }),
  evidence: [Provenance.makeEvidence({ source: "LLMS.md", ref: "v4.0.0-rc.109" })]
})

const roundTrip = <A>(schema: Schema.Schema<A>, value: A): void => {
  const json = Schema.encodeSync(schema as any)(value)
  const decoded = Schema.decodeUnknownSync(schema as any)(json) as A
  expect(Schema.encodeSync(schema as any)(decoded)).toEqual(json)
}

describe("Serialization round-trips", () => {
  it("MachineOutput", () => {
    const output = ExitStatus.makeMachineOutput({
      status: ExitStatus.Exit.Error,
      findings: [finding]
    })
    roundTrip(ExitStatus.MachineOutput, output)
  })

  it("PackManifest", () => {
    const manifest = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: effect109,
      upstream,
      includedPaths: ["LLMS.md", "ai-docs"],
      sourceUrl: "https://github.com/effect-ts/effect",
      status: "complete"
    })
    roundTrip(ReferencePack.PackManifest, manifest)
  })

  it("Guidance", () => {
    const guidance = Guidance.makeGuidance({
      id: "g-pipe",
      topic: "piping",
      summary: "Prefer pipe.",
      source: "upstream",
      validationStatus: "validated",
      evidence: [],
      appliesTo: Guidance.makeAppliesTo({ from: "4.0.0" })
    })
    roundTrip(Guidance.Guidance, guidance)
  })

  it("Rule", () => {
    const rule = Rule.makeRule({
      id: "lens/no-async-function",
      title: "No async functions",
      kind: "lens-strict",
      severity: "error",
      rationale: "async/await is not Effect-first.",
      exceptions: ["Interop bridge files."]
    })
    roundTrip(Rule.Rule, rule)
  })

  it("DriftReport", () => {
    const report = Drift.makeDriftReport({
      toolchain: Drift.makeToolchainManifest({
        lensVersion: "0.0.0",
        effect: effect109,
        packageManager: "pnpm@11.20.0",
        node: "v24.19.0"
      }),
      entries: [
        Drift.makeDriftEntry({
          packageIdentity: effect109,
          kind: "compatible",
          expected: upstream,
          actual: upstream
        })
      ],
      generatedAt: DateTime.makeUnsafe(new Date("2026-08-14T00:00:00.000Z"))
    })
    roundTrip(Drift.DriftReport, report)
  })

  it("Resolution", () => {
    const resolution = Resolver.makeResolution({
      expected: effect109,
      installed: effect109,
      lockfile: "pnpm-lock",
      status: "resolved"
    })
    roundTrip(Resolver.Resolution, resolution)
  })

  it("PackVerificationResult", () => {
    const manifest = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: effect109,
      upstream,
      includedPaths: ["LLMS.md"],
      status: "complete"
    })
    const result = PackVerifier.makePackVerificationResult({
      resolution: Resolver.makeResolution({
        expected: effect109,
        installed: effect109,
        lockfile: "pnpm-lock",
        status: "resolved"
      }),
      pack: manifest,
      status: "complete"
    })
    roundTrip(PackVerifier.PackVerificationResult, result)
  })

  it("IngestDiagnostic", () => {
    const diagnostic = GuidanceIngestor.makeIngestDiagnostic({
      file: "LLMS.md",
      message: "guidance block has no summary",
      severity: "warning",
      topic: "Piping"
    })
    roundTrip(GuidanceIngestor.IngestDiagnostic, diagnostic)
  })

  it("GuidanceIngestResult", () => {
    const result = GuidanceIngestor.makeGuidanceIngestResult({
      pack: ReferencePack.makePackManifest({
        id: "pack-effect-109",
        effectVersion: "4.0.0-rc.109",
        packageIdentity: effect109,
        upstream,
        includedPaths: ["LLMS.md"],
        status: "complete"
      }),
      guidance: [
        Guidance.makeGuidance({
          id: "g-pipe",
          topic: "Piping",
          summary: "Prefer pipe.",
          source: "upstream",
          validationStatus: "validated",
          evidence: []
        })
      ],
      diagnostics: [],
      status: "ok"
    })
    roundTrip(GuidanceIngestor.GuidanceIngestResult, result)
  })
})
