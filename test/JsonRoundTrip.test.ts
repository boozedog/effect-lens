import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Drift from "../src/Drift.ts"
import * as ExitStatus from "../src/ExitStatus.ts"
import * as Finding from "../src/Finding.ts"
import * as PackageIdentity from "../src/PackageIdentity.ts"
import * as Provenance from "../src/Provenance.ts"
import * as Waiver from "../src/Waiver.ts"

/**
 * A true JSON round-trip: encode -> JSON.stringify -> JSON.parse -> decode.
 * This is the contract the CLI, pi, and Git gates actually rely on.
 */
const jsonRoundTrip = <A>(schema: Schema.Schema<A>, value: A): A => {
  const encoded = Schema.encodeSync(schema as any)(value)
  const json = JSON.parse(JSON.stringify(encoded))
  return Schema.decodeUnknownSync(schema as any)(json) as A
}

const expiry = DateTime.makeUnsafe(new Date("2026-09-01T00:00:00.000Z"))

const waiver = Waiver.makeWaiver({
  id: "w-exp",
  rule: "lens/no-async-function",
  scope: "file",
  path: "src/bridge.ts",
  reason: "Legacy interop boundary.",
  createdBy: "david",
  expiresAt: expiry
})

describe("True JSON round-trips", () => {
  it("Waiver with expiresAt", () => {
    const decoded = jsonRoundTrip(Waiver.Waiver, waiver)
    expect(Option.getOrNull(decoded.expiresAt)?.toJSON()).toBe("2026-09-01T00:00:00.000Z")
  })

  it("DriftReport with generatedAt", () => {
    const effect = PackageIdentity.makePackageIdentity({
      name: "effect",
      version: "4.0.0-rc.109",
      source: "lockfile"
    })
    const report = Drift.makeDriftReport({
      toolchain: Drift.makeToolchainManifest({ lensVersion: "0.0.0", effect }),
      entries: [
        Drift.makeDriftEntry({ role: "dependency", packageIdentity: effect, kind: "compatible" })
      ],
      generatedAt: expiry
    })
    const decoded = jsonRoundTrip(Drift.DriftReport, report)
    expect(decoded.generatedAt.toJSON()).toBe("2026-09-01T00:00:00.000Z")
  })

  it("MachineOutput with a finding that carries a waivered, expiring finding", () => {
    const finding = Finding.makeFinding({
      id: "f-1",
      rule: "lens/no-async-function",
      severity: "error",
      source: "lens-strict",
      message: "Prefer Effect composition.",
      location: Finding.makeLocation({ file: "src/a.ts", line: 1 }),
      evidence: [Provenance.makeEvidence({ source: "LLMS.md" })],
      waivers: [waiver]
    })
    const output = ExitStatus.makeMachineOutput({
      status: ExitStatus.Exit.Error,
      findings: [finding]
    })
    const decoded = jsonRoundTrip(ExitStatus.MachineOutput, output)
    expect(Option.getOrNull(decoded.findings[0].waivers[0].expiresAt)?.toJSON())
      .toBe("2026-09-01T00:00:00.000Z")
  })
})
