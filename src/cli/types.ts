/**
 * Shared types for the Effect Lens CLI adapter.
 *
 * Every command returns a {@link CliResult}: a {@link MachineOutput} that
 * drives the process exit code, a JSON-serializable payload for `--json` mode,
 * and the concise human-readable lines for default mode. The CLI is a thin
 * adapter over the shared core operations; it never re-implements policy.
 *
 * @since 0.0.0
 */
import type { MachineOutput } from "../ExitStatus.ts"

/**
 * The result of a single CLI command.
 *
 * @since 0.0.0
 */
export interface CliResult {
  /**
   * The machine-readable output that determines the process exit code.
   */
  readonly machineOutput: MachineOutput
  /**
   * The JSON-serializable payload emitted in `--json` mode.
   */
  readonly json: unknown
  /**
   * The concise human-readable lines emitted in default mode.
   */
  readonly human: Array<string>
}

/**
 * The resolved CLI invocation context shared by all commands.
 *
 * @since 0.0.0
 */
export interface CliContext {
  readonly projectDir: string
  readonly cacheDir: string
  /**
   * An explicit workspace/package target within a monorepo, resolved against
   * the root lockfile. Optional; when absent, the root importer is used.
   */
  readonly workspace?: string | undefined
}
