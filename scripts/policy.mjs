#!/usr/bin/env node
/**
 * Effect Lens policy/metadata validation (issue #7).
 *
 * Deterministically validates the committed policy and reference metadata
 * that the self-dogfood check relies on, so CI can reject invalid waivers,
 * broken reference-pack manifests, and malformed guidance without inventing a
 * broad policy system:
 *
 *   1. waivers  — the committed `waivers.json` decodes against the Waiver
 *                 schema and is scope/path consistent (global has no path;
 *                 path/file require one).
 *   2. packs    — every production reference-pack manifest under the cache
 *                 decodes against the PackManifest schema, declares
 *                 `complete`, and every included file exists on disk.
 *   3. guidance — ingesting each production pack produces no `warning` or
 *                 `error` diagnostics (malformed or conflicting guidance).
 *
 * The check is strictly read-only and deterministic. It reuses the shared
 * Schema contracts from `src/` rather than reimplementing policy. Checks the
 * current contracts do not support (live upstream comparison, remote pack
 * acquisition, full semver ranges, semantic contradiction analysis, waiver
 * expiry enforcement) are reported explicitly as deferred rather than silently
 * skipped.
 *
 * Usage:
 *   node --experimental-strip-types scripts/policy.mjs [--waivers <file>] [--cache <dir>]
 *
 * Exits 0 when every check passes, 1 otherwise.
 *
 * @since 0.0.0
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as GuidanceIngestor from "../src/GuidanceIngestor.ts"
import * as ReferencePack from "../src/ReferencePack.ts"
import * as Waiver from "../src/Waiver.ts"

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_WAIVERS = "waivers.json"
const DEFAULT_CACHE = join("test", "fixtures", "cache")

/**
 * Converts a decoded `expiresAt` value to epoch milliseconds, or `null` when
 * it is absent or unparseable. On the live decode path the value is a
 * `DateTime.Utc` with an `epochMilliseconds` field; the string and number
 * branches are defensive fallbacks so the check never throws on a value of
 * another shape.
 *
 * @since 0.0.0
 */
const toEpochMs = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return value
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) {
    return value.epochMilliseconds
  }
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Checks the committed waivers file: it must be a JSON array whose entries
 * decode against the Waiver schema and are scope/path consistent. Expired
 * waivers are reported but do not fail the check (expiry is advisory).
 *
 * @since 0.0.0
 */
const validateWaivers = (waiversFile) => {
  if (!existsSync(waiversFile)) {
    return {
      ok: false,
      detail: `waivers file missing: ${waiversFile}`,
      payload: { file: waiversFile, count: 0, problems: ["waivers file missing"], expired: [] }
    }
  }
  let json
  try {
    json = JSON.parse(readFileSync(waiversFile, "utf8"))
  } catch (err) {
    return {
      ok: false,
      detail: `waivers file is not valid JSON: ${err.message}`,
      payload: { file: waiversFile, count: 0, problems: ["unparseable JSON"], expired: [] }
    }
  }
  if (!Array.isArray(json)) {
    return {
      ok: false,
      detail: "waivers file must be a JSON array",
      payload: { file: waiversFile, count: 0, problems: ["not an array"], expired: [] }
    }
  }
  const problems = []
  const expired = []
  for (let i = 0; i < json.length; i++) {
    const decoded = Schema.decodeUnknownOption(Waiver.Waiver)(json[i])
    if (Option.isNone(decoded)) {
      problems.push(`waiver[${i}] does not decode against the Waiver schema`)
      continue
    }
    const waiver = decoded.value
    const path = Option.getOrNull(waiver.path)
    if (waiver.scope === "global" && path !== null) {
      problems.push(`waiver[${i}] (${waiver.id}) has global scope but a path`)
    }
    if (waiver.scope !== "global" && path === null) {
      problems.push(`waiver[${i}] (${waiver.id}) has ${waiver.scope} scope but no path`)
    }
    const ms = toEpochMs(Option.getOrNull(waiver.expiresAt))
    if (ms !== null && ms < Date.now()) {
      expired.push(waiver.id)
    }
  }
  const ok = problems.length === 0
  return {
    ok,
    detail: ok
      ? `${json.length} waiver(s) valid${expired.length > 0 ? `, ${expired.length} expired` : ""}`
      : `${problems.length} waiver problem(s)`,
    payload: { file: waiversFile, count: json.length, problems, expired }
  }
}

/**
 * Checks every production reference-pack manifest under the cache: it must
 * decode against the PackManifest schema, declare `complete`, and have every
 * included file present on disk.
 *
 * @since 0.0.0
 */
const validatePacks = (cacheDir) => {
  let entries
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return {
      ok: false,
      detail: `cache directory missing: ${cacheDir}`,
      payload: { cacheDir, packs: [], problems: ["cache directory missing"] }
    }
  }
  const problems = []
  const packs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packDir = join(cacheDir, entry.name)
    const manifestPath = join(packDir, "manifest.json")
    if (!existsSync(manifestPath)) continue
    let json
    try {
      json = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch (err) {
      problems.push(`${entry.name}: manifest is not valid JSON (${err.message})`)
      continue
    }
    const decoded = Schema.decodeUnknownOption(ReferencePack.PackManifest)(json)
    if (Option.isNone(decoded)) {
      problems.push(`${entry.name}: manifest does not decode against the PackManifest schema`)
      continue
    }
    const manifest = decoded.value
    if (manifest.status !== "complete") {
      problems.push(`${entry.name}: production pack status is ${manifest.status}, expected complete`)
    }
    const missing = manifest.includedPaths.filter((p) => !existsSync(join(packDir, p)))
    if (missing.length > 0) {
      problems.push(`${entry.name}: missing included file(s): ${missing.join(", ")}`)
    }
    packs.push({
      id: manifest.id,
      effectVersion: manifest.effectVersion,
      includedPaths: manifest.includedPaths.length
    })
  }
  const ok = problems.length === 0
  return {
    ok,
    detail: ok
      ? `${packs.length} production pack(s) complete`
      : `${problems.length} pack problem(s)`,
    payload: { cacheDir, packs, problems }
  }
}

/**
 * Ingests every production pack and fails on any `warning` or `error`
 * diagnostic (malformed or conflicting guidance). `info` diagnostics (e.g. a
 * title-only file with no guidance blocks) are notes, not violations.
 *
 * @since 0.0.0
 */
const validateGuidance = (cacheDir) => {
  let entries
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return {
      ok: false,
      detail: `cache directory missing: ${cacheDir}`,
      payload: { cacheDir, packs: 0, records: 0, problems: ["cache directory missing"] }
    }
  }
  const problems = []
  let records = 0
  let packCount = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packDir = join(cacheDir, entry.name)
    if (!existsSync(join(packDir, "manifest.json"))) continue
    packCount++
    const result = GuidanceIngestor.ingestPackDir({ packDir })
    records += result.guidance.length
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === "warning" || diagnostic.severity === "error") {
        problems.push(`${entry.name}: [${diagnostic.severity}] ${diagnostic.message}`)
      }
    }
  }
  const ok = problems.length === 0
  return {
    ok,
    detail: ok
      ? `${packCount} pack(s) ingested, ${records} guidance record(s), no problems`
      : `${problems.length} guidance problem(s)`,
    payload: { cacheDir, packs: packCount, records, problems }
  }
}

/**
 * Checks the current contracts do not support. Reported explicitly so they are
 * not silently skipped; each is a documented deferral, not a gap in this check.
 *
 * @since 0.0.0
 */
const UNSUPPORTED = [
  "live upstream tooling comparison (drift against upstream) — not available in the offline slice",
  "remote reference-pack acquisition — packs are committed fixtures, never fetched",
  "full semver range semantics (^, ~, x wildcards) — only numeric-semver prefixes are compared",
  "semantic contradiction analysis — conflict detection is a same-topic/different-summary heuristic",
  "waiver expiry enforcement — expired waivers are reported but do not fail the check"
]

/**
 * Runs the three policy checks (waivers, packs, guidance) and returns the
 * aggregate outcome plus the deferred-check list.
 *
 * @since 0.0.0
 */
export const runPolicy = (args) => {
  const repoRoot = resolve(args.repoRoot ?? defaultRepoRoot)
  const waiversFile = resolve(args.waiversFile ?? join(repoRoot, DEFAULT_WAIVERS))
  const cacheDir = resolve(args.cacheDir ?? join(repoRoot, DEFAULT_CACHE))
  const waivers = validateWaivers(waiversFile)
  const packs = validatePacks(cacheDir)
  const guidance = validateGuidance(cacheDir)
  const checks = [
    { name: "waivers", ok: waivers.ok, detail: waivers.detail },
    { name: "packs", ok: packs.ok, detail: packs.detail },
    { name: "guidance", ok: guidance.ok, detail: guidance.detail }
  ]
  return {
    ok: checks.every((c) => c.ok),
    checks,
    payloads: { waivers: waivers.payload, packs: packs.payload, guidance: guidance.payload },
    unsupported: UNSUPPORTED
  }
}

/**
 * Renders the policy summary to stdout and returns the process exit code.
 *
 * @since 0.0.0
 */
const render = (result) => {
  process.stdout.write("effect-lens policy\n")
  for (const c of result.checks) {
    process.stdout.write(`  ${c.ok ? "ok" : "FAILED"}: ${c.name} — ${c.detail}\n`)
  }
  process.stdout.write("deferred (not enforced):\n")
  for (const u of result.unsupported) {
    process.stdout.write(`  - ${u}\n`)
  }
  if (result.ok) {
    process.stdout.write("policy passed\n")
    return 0
  }
  process.stdout.write("policy FAILED\n")
  return 1
}

// CLI entry: parse optional overrides and run the policy check.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const option = (flag) => {
    const index = argv.indexOf(flag)
    return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
  }
  const result = runPolicy({
    waiversFile: option("--waivers"),
    cacheDir: option("--cache")
  })
  process.exitCode = render(result)
}
