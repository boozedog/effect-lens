/**
 * Read-only `doctor` operation: build the diagnostics for a project's Effect
 * resolution and reference-pack verification.
 *
 * This centralizes the error-vs-warning policy for the `doctor` surface so the
 * CLI (and any future adapter) is a thin renderer rather than a second policy
 * implementation. It never fetches packs and never mutates caches or
 * configuration.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option"
import type { Diagnostic } from "../Finding.ts"
import * as PackVerifier from "../PackVerifier.ts"
import * as Resolver from "../Resolver.ts"
import { makeDiagnostic } from "./shared.ts"

/**
 * Builds the diagnostics for the Effect resolution outcome.
 *
 * - `missing` — no declared Effect dependency: blocking `error`.
 * - `workspace-ambiguous` — the requested workspace target matches more than
 *   one lockfile importer: blocking `error`.
 * - `workspace-unresolved` — the requested workspace target matches no
 *   supported importer: blocking `error`.
 * - `installed-mismatch` / `missing-lockfile` / `unsupported-lockfile` —
 *   advisory `warning`.
 * - `resolved` — no diagnostic.
 *
 * @since 0.0.0
 */
const resolutionDiagnostics = (resolution: Resolver.Resolution): Array<Diagnostic> => {
  switch (resolution.status) {
    case "missing":
      return [
        makeDiagnostic({
          id: "doctor-effect-missing",
          severity: "error",
          message: "no effect dependency declared in lockfile or package.json"
        })
      ]
    case "workspace-ambiguous":
      return [
        makeDiagnostic({
          id: "doctor-workspace-ambiguous",
          severity: "error",
          message: Option.getOrNull(resolution.detail) ??
            "workspace target is ambiguous; specify the full importer path"
        })
      ]
    case "workspace-unresolved":
      return [
        makeDiagnostic({
          id: "doctor-workspace-unresolved",
          severity: "error",
          message: Option.getOrNull(resolution.detail) ??
            "workspace target does not match any supported importer"
        })
      ]
    case "installed-mismatch":
      return [
        makeDiagnostic({
          id: "doctor-installed-mismatch",
          severity: "warning",
          message: Option.getOrNull(resolution.detail) ??
            "installed effect does not match the declared version"
        })
      ]
    case "missing-lockfile":
      return [
        makeDiagnostic({
          id: "doctor-missing-lockfile",
          severity: "warning",
          message: Option.getOrNull(resolution.detail) ??
            "no supported lockfile found; expected identity from package.json"
        })
      ]
    case "unsupported-lockfile":
      return [
        makeDiagnostic({
          id: "doctor-unsupported-lockfile",
          severity: "warning",
          message: Option.getOrNull(resolution.detail) ??
            "unsupported lockfile detected; expected identity from package.json"
        })
      ]
    case "resolved":
      return []
  }
}

/**
 * Builds the diagnostics for the reference-pack verification outcome.
 *
 * - `missing` / `stale` / `partial` — advisory `warning`.
 * - `complete` — no diagnostic.
 *
 * @since 0.0.0
 */
const packDiagnostics = (pack: PackVerifier.PackVerificationResult): Array<Diagnostic> => {
  switch (pack.status) {
    case "missing":
      return [
        makeDiagnostic({
          id: "doctor-pack-missing",
          severity: "warning",
          message: Option.getOrNull(pack.message) ?? "no reference pack found"
        })
      ]
    case "stale":
      return [
        makeDiagnostic({
          id: "doctor-pack-stale",
          severity: "warning",
          message: Option.getOrNull(pack.message) ?? "reference pack is stale"
        })
      ]
    case "partial":
      return [
        makeDiagnostic({
          id: "doctor-pack-partial",
          severity: "warning",
          message: Option.getOrNull(pack.message) ?? "reference pack is partial"
        })
      ]
    case "complete":
      return []
  }
}

/**
 * The result of a `doctor` run: the resolved Effect identity, the reference
 * pack verification, and the diagnostics that drive the exit code.
 *
 * @since 0.0.0
 */
export interface DoctorResult {
  readonly resolution: Resolver.Resolution
  readonly pack: PackVerifier.PackVerificationResult
  readonly diagnostics: Array<Diagnostic>
}

/**
 * Runs the read-only `doctor` analysis for a project.
 *
 * @since 0.0.0
 */
export const doctorDiagnostics = (args: {
  projectDir: string
  cacheDir: string
  workspace?: string | undefined
}): DoctorResult => {
  const resolution = Resolver.resolveEffectIdentity(args.projectDir, {
    workspace: args.workspace
  })
  const pack = PackVerifier.verifyReferencePack({
    projectDir: args.projectDir,
    cacheDir: args.cacheDir,
    workspace: args.workspace
  })
  return {
    resolution,
    pack,
    diagnostics: [...resolutionDiagnostics(resolution), ...packDiagnostics(pack)]
  }
}

export { PackVerifier, Resolver }
export type { Diagnostic } from "../Finding.ts"
