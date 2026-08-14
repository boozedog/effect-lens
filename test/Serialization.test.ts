import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Drift from "../src/Drift.ts"
import * as ExitStatus from "../src/ExitStatus.ts"
import * as Finding from "../src/Finding.ts"
import * as Guidance from "../src/Guidance.ts"
import * as GuidanceIngestor from "../src/GuidanceIngestor.ts"
import * as HookMutation from "../src/HookMutation.ts"
import * as Hooks from "../src/Hooks.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as PackPlan from "../src/PackPlan.ts"
import * as PackVerifier from "../src/PackVerifier.ts"
import * as Provenance from "../src/Provenance.ts"
import * as ReferencePack from "../src/ReferencePack.ts"
import * as Resolver from "../src/Resolver.ts"
import * as Rule from "../src/Rule.ts"
import * as Setup from "../src/Setup.ts"
import * as SetupApply from "../src/SetupApply.ts"

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
          role: "dependency",
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

  it("PackCatalog", () => {
    const manifest = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: effect109,
      upstream,
      includedPaths: ["LLMS.md"],
      status: "complete"
    })
    const catalog = PackPlan.makePackCatalog({
      name: "baseline",
      baseline: "test/fixtures/cache",
      entries: [manifest]
    })
    roundTrip(PackPlan.PackCatalog, catalog)
  })

  it("PackAcquisitionPlan (already-complete)", () => {
    const resolution = Resolver.makeResolution({
      expected: effect109,
      installed: effect109,
      lockfile: "pnpm-lock",
      status: "resolved"
    })
    const manifest109 = ReferencePack.makePackManifest({
      id: "pack-effect-109",
      effectVersion: "4.0.0-rc.109",
      packageIdentity: effect109,
      upstream,
      includedPaths: ["LLMS.md"],
      status: "complete"
    })
    const plan = PackPlan.makePackAcquisitionPlan({
      project: "/abs/project",
      cacheDir: "/abs/cache",
      resolution,
      expected: effect109,
      catalogEntry: manifest109,
      localPack: manifest109,
      action: "already-complete",
      steps: [
        PackPlan.makePackPlanStep({
          id: "pack-present",
          title: "Reference pack already complete",
          action: "already-complete"
        })
      ],
      message: "reference pack is already complete"
    })
    roundTrip(PackPlan.PackAcquisitionPlan, plan)
  })

  it("PackAcquisitionPlan (catalog-entry-missing with diagnostics)", () => {
    const resolution = Resolver.makeResolution({
      expected: effect109,
      installed: effect109,
      lockfile: "pnpm-lock",
      status: "resolved"
    })
    const plan = PackPlan.makePackAcquisitionPlan({
      project: "/abs/project",
      cacheDir: "/abs/cache",
      resolution,
      expected: effect109,
      action: "catalog-entry-missing",
      steps: [
        PackPlan.makePackPlanStep({
          id: "catalog-entry",
          title: "Provide an explicit catalog entry",
          action: "catalog-entry-missing",
          detail: "no catalog entry provides effect 4.0.0-rc.109"
        })
      ],
      diagnostics: [
        new Finding.Diagnostic({
          id: "plan-catalog-entry-missing",
          severity: "warning",
          message: "no catalog entry provides effect 4.0.0-rc.109",
          location: Option.none()
        })
      ],
      message: "no catalog entry provides effect 4.0.0-rc.109"
    })
    roundTrip(PackPlan.PackAcquisitionPlan, plan)
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

  it("HooksStatus", () => {
    const status = Hooks.makeHooksStatus({
      lensStatus: "installed",
      managers: [
        Hooks.makeHookManagerStatus({
          manager: "husky",
          present: true,
          configPath: ".husky",
          lensStatus: "installed",
          detail: "a husky hook references effect-lens"
        })
      ],
      diagnostics: []
    })
    roundTrip(Hooks.HooksStatus, status)
  })

  it("SetupPlan", () => {
    const resolution = Resolver.makeResolution({
      expected: effect109,
      installed: effect109,
      lockfile: "pnpm-lock",
      status: "resolved"
    })
    const pack = PackVerifier.makePackVerificationResult({
      resolution,
      pack: ReferencePack.makePackManifest({
        id: "pack-effect-109",
        effectVersion: "4.0.0-rc.109",
        packageIdentity: effect109,
        upstream,
        includedPaths: ["LLMS.md"],
        status: "complete"
      }),
      status: "complete"
    })
    const plan = Setup.makeSetupPlan({
      project: "/abs/path",
      packageManager: "pnpm@11.20.0",
      effect: effect109,
      resolution,
      pack,
      oxlint: Setup.makeOxlintStatus({
        configPath: ".oxlintrc.json",
        lensPluginConfigured: true,
        status: "configured"
      }),
      hooks: Hooks.makeHooksStatus({
        lensStatus: "absent",
        managers: [],
        diagnostics: []
      }),
      steps: [
        Setup.makeSetupStep({
          id: "package-manager",
          title: "Detect package manager",
          status: "ok",
          detail: "pnpm detected"
        })
      ],
      diagnostics: []
    })
    roundTrip(Setup.SetupPlan, plan)
  })

  it("HookMutationResult", () => {
    const result = HookMutation.makeHookMutationResult({
      operation: "install",
      manager: "hk",
      targetPath: "hk.pkl",
      outcome: "applied",
      changed: true,
      created: false,
      detail: "added effect-lens check step to hk.pkl"
    })
    roundTrip(HookMutation.HookMutationResult, result)
  })

  it("SetupApplyResult", () => {
    const result = SetupApply.makeSetupApplyResult({
      project: "/abs/path",
      precondition: true,
      steps: [
        SetupApply.makeSetupApplyStep({
          id: "hooks",
          title: "Install Lens hook checks",
          status: "needed",
          outcome: "applied"
        })
      ],
      hookMutation: HookMutation.makeHookMutationResult({
        operation: "install",
        manager: "hk",
        targetPath: "hk.pkl",
        outcome: "applied",
        changed: true
      }),
      diagnostics: []
    })
    roundTrip(SetupApply.SetupApplyResult, result)
  })
})
