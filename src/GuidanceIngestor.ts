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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import {
  Guidance,
  GuidanceAppliesTo,
  GuidanceValidationStatus,
  makeAppliesTo,
  makeGuidance
} from "./Guidance.ts"
import { makeEvidence, makeUpstreamRef } from "./Provenance.ts"
import { Attribution, PackManifest } from "./ReferencePack.ts"
import { compareVersions, windowsOverlap } from "./Version.ts"

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

interface ParseResult {
  blocks: Array<ParsedBlock>
  unclosedFence: boolean
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
const parseMarkdown = (file: string, content: string): ParseResult => {
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
  return { blocks, unclosedFence: inFence }
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
    if (compareVersions(from, to) >= 0) return null // empty or inverted window
    return makeAppliesTo({ from, to })
  }
  return null
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic"

// Non-lossy, injective path encoding for ids: `_` -> `_u`, `/` -> `_s`. Because
// a literal `_` never survives (it becomes `_u`), `foo/bar.md` and `foo-bar.md`
// encode to distinct strings and decoding is unambiguous.
const encodePath = (path: string): string => path.replace(/_/g, "_u").replace(/\//g, "_s")

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

interface BuiltRecord {
  guidance: Guidance
  diagnostics: Array<IngestDiagnostic>
  conflictEligible: boolean
}

const buildGuidance = (block: ParsedBlock, manifest: PackManifest): BuiltRecord => {
  const diagnostics: Array<IngestDiagnostic> = []
  let validationStatus: GuidanceValidationStatus = "validated"
  const hasSummary = block.summary !== null

  if (!hasSummary) {
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
  let appliesToValid = true
  const appliesToRaw = block.metadata["applies-to"]
  if (appliesToRaw !== undefined) {
    const parsed = parseAppliesTo(appliesToRaw)
    if (parsed === null) {
      validationStatus = "unvalidated"
      appliesToValid = false
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

  const refOverride = block.metadata["ref"]
  const ref = refOverride ?? Option.getOrNull(manifest.upstream.ref) ?? null
  // When the ref is overridden at the block level, the pack commit/sourceUrl no
  // longer describe that specific guidance; clear them so the evidence does not
  // claim the override at the wrong commit.
  const upstreamRef = makeUpstreamRef({
    repository: manifest.upstream.repository,
    ref,
    commit: refOverride !== undefined ? null : Option.getOrNull(manifest.upstream.commit) ?? null,
    sourceUrl: refOverride !== undefined
      ? null
      : Option.getOrNull(manifest.upstream.sourceUrl) ?? null
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
    id: `${manifest.id}-${encodePath(block.file)}-${slug(block.topic)}-${block.line}`,
    topic: block.topic,
    summary: block.summary ?? block.topic,
    source: "upstream",
    validationStatus,
    evidence,
    appliesTo,
    upstreamRef
  })

  // Only a record with a real summary and a valid (non-fallback) window can
  // meaningfully participate in conflict detection.
  const conflictEligible = hasSummary && appliesToValid
  return { guidance, diagnostics, conflictEligible }
}

// --- conflict detection -----------------------------------------------------

const conflictRecordIds = (
  records: Array<BuiltRecord>
): { ids: Set<string>; eligible: Map<string, boolean> } => {
  const eligible = new Map<string, boolean>()
  const byTopic = new Map<string, Array<Guidance>>()
  for (const r of records) {
    eligible.set(r.guidance.id, r.conflictEligible)
    const list = byTopic.get(r.guidance.topic) ?? []
    list.push(r.guidance)
    byTopic.set(r.guidance.topic, list)
  }
  const ids = new Set<string>()
  for (const [, list] of byTopic) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].summary === list[j].summary) continue
        if (!eligible.get(list[i].id) || !eligible.get(list[j].id)) continue
        const a = Option.getOrNull(list[i].appliesTo)
        const b = Option.getOrNull(list[j].appliesTo)
        if (a === null || b === null) continue
        // Flag only the specific overlapping contradictory pair.
        if (windowsOverlap(a, b)) {
          ids.add(list[i].id)
          ids.add(list[j].id)
        }
      }
    }
  }
  return { ids, eligible }
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

const applyConflicts = (records: Array<BuiltRecord>): {
  guidance: Array<Guidance>
  diagnostics: Array<IngestDiagnostic>
} => {
  const { ids } = conflictRecordIds(records)
  const diagnostics: Array<IngestDiagnostic> = []
  const guidance = records.map((r) => r.guidance)
  if (ids.size === 0) return { guidance, diagnostics }
  for (const g of guidance) {
    if (ids.has(g.id)) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: g.evidence[0]?.source ?? g.topic,
          message: `conflicting guidance for topic: ${g.topic}`,
          severity: "error",
          topic: g.topic
        })
      )
    }
  }
  return {
    guidance: guidance.map((g) => (ids.has(g.id) ? withStatus(g, "conflict") : g)),
    diagnostics
  }
}

// --- file collection and ingestion ------------------------------------------

const listMarkdown = (dir: string, root: string): Array<string> => {
  const files: Array<string> = []
  const walk = (current: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(relative(root, full))
      }
    }
  }
  walk(dir)
  return files
}

const ingestFiles = (packDir: string, manifest: PackManifest): GuidanceIngestResult => {
  const diagnostics: Array<IngestDiagnostic> = []
  const records: Array<BuiltRecord> = []
  const packRoot = resolve(packDir)
  const seen = new Set<string>()

  for (const rawPath of manifest.includedPaths) {
    const full = resolve(packRoot, rawPath)
    if (full !== packRoot && !full.startsWith(packRoot + sep)) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: rawPath,
          message: `included path resolves outside the pack directory: ${rawPath}`,
          severity: "error"
        })
      )
      continue
    }
    if (!existsSync(full)) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: rawPath,
          message: `included file missing: ${rawPath}`,
          severity: "error"
        })
      )
      continue
    }
    const stat = statSync(full)
    const filePaths = stat.isDirectory() ? listMarkdown(full, packRoot) : [rawPath]
    if (stat.isDirectory() && filePaths.length === 0) {
      diagnostics.push(
        makeIngestDiagnostic({
          file: rawPath,
          message: `no markdown files found under included directory: ${rawPath}`,
          severity: "info"
        })
      )
    }
    for (const path of filePaths) {
      if (seen.has(path)) continue
      seen.add(path)
      const fullFile = join(packRoot, path)
      let content: string
      try {
        content = readFileSync(fullFile, "utf8")
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
      const parsed = parseMarkdown(path, content)
      if (parsed.unclosedFence) {
        diagnostics.push(
          makeIngestDiagnostic({
            file: path,
            message: `unclosed code fence in file: ${path}`,
            severity: "warning"
          })
        )
      }
      if (parsed.blocks.length === 0) {
        diagnostics.push(
          makeIngestDiagnostic({
            file: path,
            message: "no guidance blocks found",
            severity: "info"
          })
        )
      }
      for (const block of parsed.blocks) {
        const built = buildGuidance(block, manifest)
        records.push(built)
        diagnostics.push(...built.diagnostics)
      }
    }
  }

  const applied = applyConflicts(records)
  diagnostics.push(...applied.diagnostics)
  const status: IngestStatus = diagnostics.length > 0 ? "partial" : "ok"
  return makeGuidanceIngestResult({
    pack: manifest,
    guidance: applied.guidance,
    diagnostics,
    status
  })
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
