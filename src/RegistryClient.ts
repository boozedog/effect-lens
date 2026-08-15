/**
 * The explicit, injectable registry client used by the read-only freshness
 * recommendation (issue #15).
 *
 * The freshness command is the ONLY network-backed surface in Effect Lens. It
 * uses an explicit HTTP client (Node's global `fetch`) against the npm
 * registry; it never invokes `npm` and never mutates package manifests,
 * lockfiles, or pack caches. The client is injectable so tests can supply a
 * deterministic snapshot without any network access.
 *
 * @since 0.0.0
 */
import { makeRegistrySnapshot, makeRegistryVersion, RegistrySnapshot } from "./Freshness.ts"

/**
 * Fetches a package's registry snapshot. Implementations MUST be read-only and
 * MUST NOT mutate anything; they may throw to signal a network/registry
 * failure, which the freshness operation maps to a `network-error` result.
 *
 * @since 0.0.0
 */
export interface RegistryClient {
  readonly fetchSnapshot: (name: string) => Promise<RegistrySnapshot>
}

/**
 * Builds a {@link RegistryClient} that fetches a package's metadata from an npm
 * registry endpoint (default `https://registry.npmjs.org`) using Node's global
 * `fetch`. Read-only: it performs a single GET and never writes anything. It is
 * written as a promise chain (not `async`/`await`) so it stays Lens-strict
 * compliant.
 *
 * @since 0.0.0
 */
export const npmRegistryClient = (baseUrl = "https://registry.npmjs.org"): RegistryClient => ({
  fetchSnapshot(name) {
    const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(name)}`
    return fetch(url, { headers: { accept: "application/json" } }).then((res) => {
      if (!res.ok) {
        throw new Error(`registry request for ${name} failed with status ${res.status}`)
      }
      return res.json()
    }).then((data: unknown) => parseRegistryResponse(data))
  }
})

/**
 * Parses an npm registry metadata response into a {@link RegistrySnapshot}.
 * Deterministic and defensive: it reads `name`, `dist-tags`, `versions`, and
 * `time` (publish timestamps) and ignores anything else. A missing or
 * non-object `versions` yields an empty snapshot, never an error.
 *
 * @since 0.0.0
 */
export const parseRegistryResponse = (data: unknown): RegistrySnapshot => {
  const obj = (data ?? {}) as {
    name?: unknown
    "dist-tags"?: unknown
    versions?: unknown
    time?: unknown
  }
  const name = typeof obj.name === "string" && obj.name !== "" ? obj.name : "effect"
  const distTags: Record<string, string> = {}
  if (obj["dist-tags"] !== null && typeof obj["dist-tags"] === "object") {
    for (const [key, value] of Object.entries(obj["dist-tags"])) {
      if (typeof value === "string") distTags[key] = value
    }
  }
  const time = obj.time !== null && typeof obj.time === "object"
    ? (obj.time as Record<string, unknown>)
    : {}
  const versions: Array<ReturnType<typeof makeRegistryVersion>> = []
  if (obj.versions !== null && typeof obj.versions === "object") {
    for (const [version, entry] of Object.entries(obj.versions)) {
      if (entry === null || typeof entry !== "object") continue
      const declared = (entry as { version?: unknown }).version
      const ver = typeof declared === "string" && declared !== "" ? declared : version
      const publishedAt = typeof time[ver] === "string" ? time[ver] : null
      versions.push(makeRegistryVersion({ version: ver, publishedAt }))
    }
  }
  return makeRegistrySnapshot({ name, distTags, versions })
}

export type { RegistrySnapshot } from "./Freshness.ts"
