/**
 * Shared semver-aware version comparison and applicability-window helpers.
 *
 * This is the single source of truth for deciding whether a piece of guidance
 * (or a rule) applies to a given Effect version. Guidance ingestion, lookup,
 * and design all use these helpers so version applicability is computed
 * identically everywhere. The comparison is semver-aware: a release is greater
 * than any prerelease of the same core version (`4.0.0 > 4.0.0-rc.109`), and
 * prerelease identifiers are compared dot-by-dot with numeric identifiers
 * compared numerically.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import type { GuidanceAppliesTo } from "./Guidance.ts"

interface ParsedVersion {
  core: Array<number>
  pre: Array<string>
}

const parseVersion = (v: string): ParsedVersion => {
  const [coreStr, preStr] = v.split("-", 2)
  const core = coreStr.split(".").map((n) => parseInt(n, 10) || 0)
  const pre = preStr === undefined ? [] : preStr.split(".")
  return { core, pre }
}

const compareIdentifiers = (a: string, b: string): number => {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) {
    const x = parseInt(a, 10)
    const y = parseInt(b, 10)
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (aNum) return -1 // numeric identifiers are always less than alphanumeric
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

const comparePrerelease = (a: Array<string>, b: Array<string>): number => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const c = compareIdentifiers(a[i], b[i])
    if (c !== 0) return c
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * Semver-aware comparison of two version strings. Returns a negative number
 * when `a < b`, zero when equal, and a positive number when `a > b`.
 *
 * @since 0.0.0
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const coreLen = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < coreLen; i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  return comparePrerelease(pa.pre, pb.pre)
}

/**
 * True when two half-open windows `[from, to)` overlap. A null `to` is
 * open-ended.
 *
 * @since 0.0.0
 */
export const windowsOverlap = (a: GuidanceAppliesTo, b: GuidanceAppliesTo): boolean => {
  const aTo = Option.getOrNull(a.to)
  const bTo = Option.getOrNull(b.to)
  const aFromBeforeBTo = bTo === null ? true : compareVersions(a.from, bTo) < 0
  const bFromBeforeATo = aTo === null ? true : compareVersions(b.from, aTo) < 0
  return aFromBeforeBTo && bFromBeforeATo
}

/**
 * True when `version` falls inside the half-open window `[from, to)`. A null
 * `to` is open-ended. A version equal to `from` is included; a version equal
 * to `to` is excluded.
 *
 * @since 0.0.0
 */
export const versionInWindow = (version: string, window: GuidanceAppliesTo): boolean => {
  const to = Option.getOrNull(window.to)
  const afterFrom = compareVersions(version, window.from) >= 0
  const beforeTo = to === null ? true : compareVersions(version, to) < 0
  return afterFrom && beforeTo
}
