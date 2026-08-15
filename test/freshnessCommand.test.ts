/**
 * Tests for the `effect-lens freshness` CLI command (issue #15).
 *
 * These exercise the CLI adapter with an injected, deterministic registry
 * client so no network access is required. They cover a beta.83 workspace
 * receiving an actionable RC recommendation, the JSON payload shape, network
 * failure mapping to `network-error`, and the read-only guarantee (no cache
 * mutation). The Effect programs are run with `it.effect` (Lens-strict
 * compliant; no `async`/`await`).
 *
 * @since 0.0.0
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { freshness } from "../src/cli/commands/freshness.ts"
import * as Freshness from "../src/Freshness.ts"
import type { RegistryClient } from "../src/RegistryClient.ts"

const monorepo = fileURLToPath(new URL("./fixtures/projects/monorepo", import.meta.url))
const catalogDir = fileURLToPath(new URL("./fixtures/catalog", import.meta.url))

const trackedDirs: Array<string> = []
const track = (dir: string): string => {
  trackedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true })
  trackedDirs.length = 0
})

const tempCache = (): string => track(mkdtempSync(join(tmpdir(), "el-fresh-cli-")))

const snapshot = (): Freshness.RegistrySnapshot =>
  Freshness.makeRegistrySnapshot({
    name: "effect",
    distTags: { rc: "4.0.0-rc.109" },
    versions: [
      Freshness.makeRegistryVersion({
        version: "4.0.0-beta.83",
        publishedAt: "2026-01-01T00:00:00.000Z"
      }),
      Freshness.makeRegistryVersion({
        version: "4.0.0-rc.109",
        publishedAt: "2026-01-10T00:00:00.000Z"
      })
    ]
  })

const okClient: RegistryClient = {
  fetchSnapshot: () => Promise.resolve(snapshot())
}

const failingClient: RegistryClient = {
  fetchSnapshot: () => Promise.reject(new Error("connection refused"))
}

describe("freshness command", () => {
  it.effect("recommends the current allowed RC to a beta.83 workspace", () =>
    Effect.gen(function*() {
      const cacheDir = tempCache()
      const result = yield* freshness({
        projectDir: monorepo,
        cacheDir,
        workspace: "packages/foldkit",
        registry: okClient
      })
      const rec = (result.json as {
        recommendation: {
          status: string
          installed: { version: string } | null
          candidate: { version: string } | null
          channel: string | null
          cooldown: { allowed: boolean } | null
          packStatus: string | null
        }
      }).recommendation
      expect(result.machineOutput.status).toBe(1)
      expect(rec.status).toBe("recommendation")
      expect(rec.installed?.version).toBe("4.0.0-beta.83")
      expect(rec.candidate?.version).toBe("4.0.0-rc.109")
      expect(rec.channel).toBe("beta")
      expect(rec.cooldown?.allowed).toBe(true)
      // No catalog provided -> pack status unknown.
      expect(rec.packStatus).toBe("unknown")
      // Read-only: the cache is never mutated.
      expect(readdirSync(cacheDir)).toEqual([])
    }))

  it.effect("reports the candidate pack status when a catalog is provided", () =>
    Effect.gen(function*() {
      const cacheDir = tempCache()
      const result = yield* freshness({
        projectDir: monorepo,
        cacheDir,
        workspace: "packages/foldkit",
        catalogDir,
        registry: okClient
      })
      const rec = (result.json as {
        recommendation: { packStatus: string | null; packId: string | null }
      }).recommendation
      // The catalog has an rc.109 entry (pack-effect-109) but the pack is not
      // cached in the temp cache, so the candidate's pack is not-cached
      // (actionable, not fetched).
      expect(rec.packStatus).toBe("not-cached")
      expect(rec.packId).toBe("pack-effect-109")
      expect(readdirSync(cacheDir)).toEqual([])
    }))

  it.effect("maps a registry fetch failure to a network-error warning", () =>
    Effect.gen(function*() {
      const cacheDir = tempCache()
      const result = yield* freshness({
        projectDir: monorepo,
        cacheDir,
        workspace: "packages/foldkit",
        registry: failingClient
      })
      const rec = (result.json as {
        recommendation: {
          status: string
          installed: { version: string } | null
          declaredSpecifier: string | null
          channel: string | null
        }
      }).recommendation
      expect(result.machineOutput.status).toBe(1)
      expect(rec.status).toBe("network-error")
      // The identity is still reported from the resolution even on a fetch failure.
      expect(rec.installed?.version).toBe("4.0.0-beta.83")
      expect(rec.declaredSpecifier).toBe("4.0.0-beta.83")
      expect(rec.channel).toBe("beta")
      expect(
        result.machineOutput.diagnostics.some((d) => d.id === "freshness-network-error")
      ).toBe(true)
      expect(readdirSync(cacheDir)).toEqual([])
    }))

  it.effect("reports up-to-date for a workspace already on the newest allowed version", () =>
    Effect.gen(function*() {
      const cacheDir = tempCache()
      const result = yield* freshness({
        projectDir: monorepo,
        cacheDir,
        workspace: "packages/docs",
        registry: okClient
      })
      const rec = (result.json as {
        recommendation: { status: string; candidate: { version: string } | null }
      }).recommendation
      // docs is on rc.109, the newest allowed version.
      expect(result.machineOutput.status).toBe(0)
      expect(rec.status).toBe("up-to-date")
      expect(rec.candidate).toBeNull()
    }))
})
