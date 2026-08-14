/**
 * Read-only ingestion and normalization of guidance from verified local
 * reference packs.
 *
 * The ingestor reads a pack's included markdown files, parses guidance
 * blocks, and normalizes them into `Guidance` records with `Evidence` that
 * preserve the source path, the pack's upstream ref, and Effect version
 * applicability. It never fetches or mutates packs. Malformed blocks are
 * surfaced as `unvalidated`; contradictory blocks sharing a topic are surfaced
 * as `conflict`. Diagnostics and a per-ingest status let callers inspect what
 * happened instead of silently overwriting records.
 *
 * This slice is Effect-pack-only: every ingested record is `source: "upstream"`.
 * Importing effect-solutions material (which must be labeled distinctly) is out
 * of scope for this slice.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  Guidance,
  GuidanceAppliesTo,
  GuidanceValidationStatus,
  makeAppliesTo,
  makeGuidance
} from "./Guidance.ts"
import { makeEvidence, makeUpstreamRef } from "./Provenance.ts"
import { Attribution, PackManifest } from "./ReferencePack.ts"

/**
 * Severity of an ingestion diagnostic.
 *
 * @since 0.0.0
 */
export const IngestDiagnosticSeverity = Schema.Literals(["info", "warning", "error"])
export type IngestDiagnosticSeverity = Schema.Schema.Type<typeof IngestDiagnosticSeverity>

/**
 * A single problem or note produced while ingesting a pack. Callers can
 * inspect these to see why a record is `unvalidated` or `conflict` rather than
 * silently dropping or overwriting it.
 *
 * @since 0.0.0
 */
export class IngestDiagnostic extends Schema.Class<IngestDiagnostic>("IngestDiagnostic")({
  file: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  severity: IngestDiagnosticSeverity,
  topic: Schema.OptionFromNullOr(Schema.NonEmptyString)
}) {}

/**
 * Constructs an {@link IngestDiagnostic} value.
 *
 * @since 0.0.0
 */
export const makeIngestDiagnostic = (args: {
  file: string
  message: string
  severity: IngestDiagnosticSeverity
  topic?: string | null
}): IngestDiagnostic =>
  new IngestDiagnostic({
    file: args.file,
    message: args.message,
    severity: args.severity,
    topic: Option.fromNullishOr(args.topic)
  })

/**
 * Aggregate outcome of an ingestion run.
 *
 * - `ok` — no diagnostics; every record is `validated`.
 * - `partial` — ingestion completed but produced diagnostics (malformed,
 *   conflicting, or missing-file records).
 * - `failed` — the pack manifest could not be read or parsed.
 *
 * @since 0.0.0
 */
export const IngestStatus = Schema.Literals(["ok", "partial", "failed"])
export type IngestStatus = Schema.Schema.Type<typeof IngestStatus>

/**
 * The result of ingesting a reference pack: the pack manifest (when readable),
 * the normalized `Guidance` records, the diagnostics, and an aggregate status.
 *
 * @since 0.0.0
 */
export class GuidanceIngestResult
  extends Schema.Class<GuidanceIngestResult>("GuidanceIngestResult")({
    pack: Schema.OptionFromNullOr(PackManifest),
    guidance: Schema.Array(Guidance),
    diagnostics: Schema.Array(IngestDiagnostic),
    status: IngestStatus
  })
{}

/**
 * Constructs a {@link GuidanceIngestResult} value.
 *
 * @since 0.0.0
 */
export const makeGuidanceIngestResult = (args: {
  pack?: PackManifest | null
  guidance: Array<Guidance>
  diagnostics: Array<IngestDiagnostic>
  status: IngestStatus
}): GuidanceIngestResult =>
  new GuidanceIngestResult({
    pack: Option.fromNullishOr(args.pack),
    guidance: args.guidance,
    diagnostics: args.diagnostics,
    status: args.status
  })

/**
 * Ingests guidance from an explicit pack directory. The directory must contain
 * a `manifest.json` plus the pack's included files. Read-only.
 *
 * @since 0.0.0
 */
export const ingestPackDir = (args: { packDir: string }): GuidanceIngestResult => {
  const manifest = readManifest(args.packDir)
  if (manifest === null) {
    return makeGuidanceIngestResult({
      pack: null,
      guidance: [],
      diagnostics: [
        makeIngestDiagnostic({
          file: "manifest.json",
          message: "pack manifest missing or unparseable",
          severity: "error"
        })
      ],
      status: "failed"
    })
  }
  return ingestFiles(args.packDir, manifest)
}

/**
 * Ingests guidance from an exact verified local pack located in `cacheDir`
 * under `cacheDir/<manifest.id>`. The caller supplies the manifest (e.g. from
 * `PackVerifier.findPack`); the ingestor reads only the pack's included files
 * and reports any that are missing. Read-only.
 *
 * @since 0.0.0
 */
export const ingestPack = (
  args: { cacheDir: string; manifest: PackManifest }
): GuidanceIngestResult => ingestFiles(join(args.cacheDir, args.manifest.id), args.manifest)

// --- markdown parsing -------------------------------------------------------

interface ParsedBlock {
  file: string
  topic: string
  summary: string | null
  line: number
  metadata: Record<string, string>
}

const HEADING_RE = /^(#{2,6})\s+(.+)$/
const H1_RE = /^#\s+(.+)$/
const FENCE_RE = /^```(\S*)\s*$/
const METADATA_RE = /^([a-z-]+):\s*(.+)$/
const VERSION_RE = /^\d+\.\d+\.\d+/

/**
 * Parses a markdown file into guidance blocks. A heading (level 2-6) starts a
 * block; the first non-empty paragraph after the heading is the summary; a
 * fenced code block tagged `lens-guidance` carries `key: value` metadata.
 * A level-1 heading is treated as a document title / section break and is
 * skipped. Heading hierarchy is preserved: a block's topic is the full heading
 * path (e.g. `Piping > More examples`), so repeated structural headings under
 * different parents do not collide.
 *
 * @internal
 */
const parseMarkdown = (file: string, content: string): Array<ParsedBlock> => {
  const lines = content.split(/\r?\n/)
  const blocks: Array<ParsedBlock> = []
  const stack: Array<{ level: number; text: string }> = []
  let current: ParsedBlock | null = null
  let inFence = false
  let fenceLang: string | null = null
  let fenceLines: Array<string> = []
  let summaryLines: Array<string> = []
  let summaryDone = false

  const flush = (): void => {
    if (current === null) return
    current.summary = summaryLines.length > 0 ? summaryLines.join(" ") : null
    blocks.push(current)
    current = null
    fenceLines = []
    summaryLines = []
    summaryDone = false
    fenceLang = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = line.match(HEADING_RE)
    const h1 = line.match(H1_RE)
    if ((heading !== null || h1 !== null) && !inFence) {
      flush()
      if (h1 !== null) {
        stack.length = 0
        continue
      }
      const level = heading![1].length
      const text = heading![2].trim()
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      stack.push({ level, text })
      current = {
        file,
        topic: stack.map((s) => s.text).join(" > "),
        summary: null,
        line: i + 1,
        metadata: {}
      }
      continue
    }
    if (current === null) continue
    const fence = line.match(FENCE_RE)
    if (fence !== null) {
      if (!inFence) {
        inFence = true
        fenceLang = fence[1]
        fenceLines = []
      } else {
        inFence = false
        if (fenceLang === "lens-guidance") {
          current.metadata = parseMetadata(fenceLines)
        }
        fenceLang = null
        fenceLines = []
      }
      continue
    }
    if (inFence) {
      fenceLines.push(line)
      continue
    }
    if (line.trim() === "") {
      if (summaryLines.length > 0) summaryDone = true
      continue
    }
    if (!summaryDone) {
      summaryLines.push(line.trim())
    }
  }
  flush()
  return blocks
}

const parseMetadata = (lines: Array<string>): Record<string, string> => {
  const meta: Record<string, string> = {}
  for (const line of lines) {
    const m = line.match(METADATA_RE)
    if (m !== null) meta[m[1]] = m[2].trim()
  }
  return meta
}

const parseAppliesTo = (raw: string): GuidanceAppliesTo | null => {
  const parts = raw.split("..")
  if (parts.length === 1) {
    const from = parts[0].trim()
    if (!VERSION_RE.test(from)) return null
    return makeAppliesTo({ from })
  }
  if (parts.length === 2) {
    const from = parts[0].trim()
    const to = parts[1].trim()
    if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) return null
    return makeAppliesTo({ from, to })
  }
  return null
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic"

const attributionString = (attribution: Attribution | null): string | null => {
  if (attribution === null) return null
  const parts: Array<string> = []
  const license = Option.getOrNull(attribution.license)
  const copyright = Option.getOrNull(attribution.copyright)
  const notice = Option.getOrNull(attribution.notice)
  if (license !== null) parts.push(license)
  if (copyright !== null) parts.push(copyright)
  if (notice !== null) parts.push(notice)
  return parts.length > 0 ? parts.join("; ") : null
}

const buildGuidance = (
  block: ParsedBlock,
  manifest: PackManifest
): { guidance: Guidance; diagnostics: Array<IngestDiagnostic> } => {
  const diagnostics: Array<IngestDiagnostic> = []
  let validationStatus: GuidanceValidationStatus = "validated"

  if (block.summary === null) {
    validationStatus = "unvalidated"
    diagnostics.push(
      makeIngestDiagnostic({
        file: block.file,
        message: "guidance block has no summary",
        severity: "warning",
        topic: block.topic
      })
    )
  }

  let appliesTo: GuidanceAppliesTo
  const appliesToRaw = block.metadata["applies-to"]
  if (appliesToRaw !== undefined) {
    const parsed = parseAppliesTo(appliesToRaw)
    if (parsed === null) {
      validationStatus = "unvalidated"
      appliesTo = makeAppliesTo({ from: manifest.effectVersion })
      diagnostics.push(
        makeIngestDiagnostic({
          file: block.file,
          message: `invalid applies-to window: ${appliesToRaw}`,
          severity: "warning",
          topic: block.topic
        })
      )
    } else {
      appliesTo = parsed
    }
  } else {
    appliesTo = makeAppliesTo({ from: manifest.effectVersion })
  }

  const ref = block.metadata["ref"] ?? Option.getOrNull(manifest.upstream.ref) ?? null
  const upstreamRef = makeUpstreamRef({
    repository: manifest.upstream.repository,
    ref,
    commit: Option.getOrNull(manifest.upstream.commit) ?? null,
    sourceUrl: Option.getOrNull(manifest.upstream.sourceUrl) ?? null
  })

  const evidence = [
    makeEvidence({
      source: block.file,
      ref,
      location: `${block.file}:${block.line}`,
      snippet: block.summary ?? null,
      attribution: attributionString(Option.getOrNull(manifest.attribution))
    })
  ]

  const guidance = makeGuidance({
    id: `${manifest.id}-${slug(block.file)}-${slug(block.topic)}-${block.line}`,
    topic: block.topic,
    summary: block.summary ?? block.topic,
    source: "upstream",
    validationStatus,
    evidence,
    appliesTo,
    upstreamRef
  })

  return { guidance, diagnostics }
}

// --- version comparison and conflict detection ------------------------------

const parseVersion = (v: string): Array<number> =>
  v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0)

const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

// Half-open windows [from, to); a null `to` is open-ended.
const windowsOverlap = (a: GuidanceAppliesTo, b: GuidanceAppliesTo): boolean => {
  const aTo = Option.getOrNull(a.to)
  const bTo = Option.getOrNull(b.to)
  const aFromBeforeBTo = bTo === null ? true : compareVersions(a.from, bTo) < 0
  const bFromBeforeATo = aTo === null ? true : compareVersions(b.from, aTo) < 0
  return aFromBeforeBTo && bFromBeforeATo
}

const conflictTopics = (guidance: Array<Guidance>): Set<string> => {
  const byTopic = new Map<string, Array<Guidance>>()
  for (const g of guidance) {
    const list = byTopic.get(g.topic) ?? []
    list.push(g)
    byTopic.set(g.topic, list)
  }
  const topics = new Set<string>()
  for (const [topic, list] of byTopic) {
    if (list.length < 2) continue
    // Flag a conflict when any pair of blocks with different summaries has
    // overlapping version windows. Non-overlapping windows are different
    // guidance for different Effect versions and are not a conflict.
    let anyOverlap = false
    for (let i = 0; i < list.length && !anyOverlap; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].summary === list[j].summary) continue
        const a = Option.getOrNull(list[i].appliesTo)
        const b = Option.getOrNull(list[j].appliesTo)
        if (a === null || b === null) continue
        if (windowsOverlap(a, b)) {
          anyOverlap = true
          break
        }
      }
    }
    if (anyOverlap) topics.add(topic)
  }
  return topics
}

const withStatus = (g: Guidance, status: GuidanceValidationStatus): Guidance =>
  makeGuidance({
    id: g.id,
    topic: g.topic,
    summary: g.summary,
    source: g.source,
    validationStatus: status,
    evidence: [...g.evidence],
    appliesTo: Option.getOrNull(g.appliesTo) ?? null,
    upstreamRef: Option.getOrNull(g.upstreamRef) ?? null
  })

const applyConflicts = (
  guidance: Array<Guidance>,
  diagnostics: Array<IngestDiagnostic>
): Array<Guidance> => {
  const topics = conflictTopics(guidance)
  if (topics.size === 0) return guidance
  for (const topic of topics) {
    diagnostics.push(
      makeIngestDiagnostic({
        file: guidance.find((g) => g.topic === topic)?.evidence[0]?.source ?? topic,
        message: `conflicting guidance for topic: ${topic}`,
        severity: "error",
        topic
      })
    )
  }
  return guidance.map((g) => (topics.has(g.topic) ? withStatus(g, "conflict") : g))
}

const ingestFiles = (packDir: string, manifest: PackManifest): GuidanceIngestResult => {
  const diagnostics: Array<IngestDiagnostic> = []
  const guidance: Array<Guidance> = []
  for (const path of manifest.includedPaths) {
    const full = join(packDir, path)
    if (!existsSync(full)) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: path,
          message: `included file missing: ${path}`,
          severity: "error"
        })
      )
      continue
    }
    let content: string
    try {
      content = readFileSync(full, "utf8")
    } catch {
      diagnostics.push(
        makeIngestDiagnostic({
          file: path,
          message: `could not read file: ${path}`,
          severity: "error"
        })
      )
      continue
    }
    const blocks = parseMarkdown(path, content)
    if (blocks.length === 0) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: path,
          message: "no guidance blocks found",
          severity: "info"
        })
      )
    }
    for (const block of blocks) {
      const built = buildGuidance(block, manifest)
      guidance.push(built.guidance)
      diagnostics.push(...built.diagnostics)
    }
  }
  const finalGuidance = applyConflicts(guidance, diagnostics)
  const status: IngestStatus = diagnostics.length > 0 ? "partial" : "ok"
  return makeGuidanceIngestResult({ pack: manifest, guidance: finalGuidance, diagnostics, status })
}

const readManifest = (packDir: string): PackManifest | null => {
  const path = join(packDir, "manifest.json")
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, "utf8")
    const json: unknown = JSON.parse(content)
    return Option.getOrNull(Schema.decodeUnknownOption(PackManifest)(json))
  } catch {
    return null
  }
}

export { Guidance, PackManifest }
export type { GuidanceAppliesTo, GuidanceValidationStatus }
