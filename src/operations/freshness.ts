/**
 * Read-only `freshness` operation: build a {@link FreshnessRecommendation} for
 * a project from an explicit registry snapshot and the channel/cooldown policy.
 *
 * This is the network-backed counterpart to the offline `drift` slice. It
 * resolves the project's Effect identity, fetches the registry snapshot via an
 * injected {@link RegistryClient}, and delegates candidate selection and policy
 * to the pure {@link computeFreshnessRecommendation}. A registry fetch failure
 * is surfaced as a `network-error` recommendation, never a crash. The operation
 * is read-only: it never mutates manifests, lockfiles, or pack caches.
 *
 * The operation is an Effect program (Lens-strict compliant): the network fetch
 * is wrapped in `Effect.tryPromise` and the flow is composed with `Effect.gen`,
 * so no `async`/`await` is used. The effect never fails — a fetch failure is
 * mapped to a `network-error` recommendation.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Freshness from "../Freshness.ts"
import * as PackPlan from "../PackPlan.ts"
import { PackManifest } from "../ReferencePack.ts"
import type { RegistryClient } from "../RegistryClient.ts"
import * as Resolver from "../Resolver.ts"

/**
 * The catalog entries to use for candidate pack status, or `null` when no
 * catalog was provided.
 *
 * @since 0.0.0
 */
const catalogEntries = (
  catalog: PackPlan.PackCatalog | ReadonlyArray<PackManifest> | null | undefined
): ReadonlyArray<PackManifest> | null => {
  if (catalog === null || catalog === undefined) return null
  return Array.isArray(catalog) ? catalog : (catalog as PackPlan.PackCatalog).entries
}

/**
 * Builds a read-only {@link FreshnessRecommendation} for a project.
 *
 * Resolves the Effect identity, fetches the registry snapshot via the injected
 * client, and computes the recommendation. A fetch failure is reported as a
 * `network-error` recommendation with a warning diagnostic. The returned effect
 * never fails.
 *
 * @since 0.0.0
 */
export const buildFreshnessRecommendation = (args: {
  projectDir: string
  cacheDir: string
  workspace?: string | undefined
  registry: RegistryClient
  catalog?: PackPlan.PackCatalog | ReadonlyArray<PackManifest> | null
  channelPolicy?: Freshness.ChannelPolicy
  cooldownPolicy?: Freshness.CooldownPolicy
  excludedVersions?: ReadonlyArray<string>
  now?: Date
}): Effect.Effect<Freshness.FreshnessRecommendation, never> =>
  Effect.gen(function*() {
    const resolution = Resolver.resolveEffectIdentity(args.projectDir, {
      workspace: args.workspace
    })
    const result = yield* Effect.tryPromise({
      try: () => args.registry.fetchSnapshot("effect"),
      catch: (err) => err
    }).pipe(
      Effect.match({
        onFailure: (err) => ({
          kind: "error" as const,
          detail: err instanceof Error ? err.message : "registry request failed"
        }),
        onSuccess: (snapshot) => ({ kind: "ok" as const, snapshot })
      })
    )
    if (result.kind === "error") {
      return Freshness.networkErrorRecommendation({
        project: args.projectDir,
        cacheDir: args.cacheDir,
        workspace: args.workspace,
        resolution,
        detail: `could not fetch the effect registry snapshot: ${result.detail}`
      })
    }
    return Freshness.computeFreshnessRecommendation({
      project: args.projectDir,
      cacheDir: args.cacheDir,
      workspace: args.workspace,
      resolution,
      registry: result.snapshot,
      catalog: catalogEntries(args.catalog),
      ...(args.channelPolicy === undefined ? {} : { channelPolicy: args.channelPolicy }),
      ...(args.cooldownPolicy === undefined ? {} : { cooldownPolicy: args.cooldownPolicy }),
      ...(args.excludedVersions === undefined ? {} : { excludedVersions: args.excludedVersions }),
      ...(args.now === undefined ? {} : { now: args.now })
    })
  })

export { Freshness, Option, PackManifest, PackPlan, Resolver }
export type { RegistryClient } from "../RegistryClient.ts"
