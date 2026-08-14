import { describe, expect, it } from "@effect/vitest"
import * as Guidance from "../src/Guidance.ts"
import * as Version from "../src/Version.ts"

describe("compareVersions", () => {
  it("orders core versions numerically", () => {
    expect(Version.compareVersions("4.0.0", "4.0.0")).toBe(0)
    expect(Version.compareVersions("3.9.0", "4.0.0")).toBeLessThan(0)
    expect(Version.compareVersions("4.1.0", "4.0.0")).toBeGreaterThan(0)
  })

  it("treats a release as greater than any prerelease of the same core", () => {
    expect(Version.compareVersions("4.0.0", "4.0.0-rc.109")).toBeGreaterThan(0)
    expect(Version.compareVersions("4.0.0-rc.109", "4.0.0")).toBeLessThan(0)
  })

  it("compares prerelease identifiers dot-by-dot with numeric precedence", () => {
    expect(Version.compareVersions("4.0.0-rc.1", "4.0.0-rc.50")).toBeLessThan(0)
    expect(Version.compareVersions("4.0.0-rc.50", "4.0.0-rc.1")).toBeGreaterThan(0)
    expect(Version.compareVersions("4.0.0-rc.1", "4.0.0-rc.1")).toBe(0)
  })

  it("treats numeric prerelease identifiers as less than alphanumeric", () => {
    expect(Version.compareVersions("4.0.0-rc.1", "4.0.0-rc.alpha")).toBeLessThan(0)
  })
})

describe("windowsOverlap", () => {
  it("detects overlapping half-open windows", () => {
    const a = Guidance.makeAppliesTo({ from: "3.0.0", to: "4.0.0" })
    const b = Guidance.makeAppliesTo({ from: "3.5.0", to: "4.5.0" })
    expect(Version.windowsOverlap(a, b)).toBe(true)
  })

  it("does not flag disjoint windows", () => {
    const a = Guidance.makeAppliesTo({ from: "3.0.0", to: "4.0.0" })
    const b = Guidance.makeAppliesTo({ from: "4.0.0", to: null })
    expect(Version.windowsOverlap(a, b)).toBe(false)
  })

  it("treats a null to as open-ended", () => {
    const a = Guidance.makeAppliesTo({ from: "3.0.0", to: null })
    const b = Guidance.makeAppliesTo({ from: "5.0.0", to: null })
    expect(Version.windowsOverlap(a, b)).toBe(true)
  })
})

describe("versionInWindow", () => {
  it("includes the from boundary and excludes the to boundary", () => {
    const window = Guidance.makeAppliesTo({ from: "4.0.0", to: "4.1.0" })
    expect(Version.versionInWindow("4.0.0", window)).toBe(true)
    expect(Version.versionInWindow("4.0.5", window)).toBe(true)
    expect(Version.versionInWindow("4.1.0", window)).toBe(false)
    expect(Version.versionInWindow("3.9.0", window)).toBe(false)
  })

  it("treats a null to as open-ended", () => {
    const window = Guidance.makeAppliesTo({ from: "4.0.0", to: null })
    expect(Version.versionInWindow("4.0.0", window)).toBe(true)
    expect(Version.versionInWindow("9.9.9", window)).toBe(true)
    expect(Version.versionInWindow("3.0.0", window)).toBe(false)
  })

  it("is prerelease-aware", () => {
    const window = Guidance.makeAppliesTo({ from: "4.0.0-rc.1", to: "4.0.0" })
    expect(Version.versionInWindow("4.0.0-rc.50", window)).toBe(true)
    expect(Version.versionInWindow("4.0.0", window)).toBe(false)
  })
})
