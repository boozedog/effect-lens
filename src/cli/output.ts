/**
 * Output rendering for the Effect Lens CLI.
 *
 * Default mode prints the concise human-readable lines; `--json` mode prints
 * the already-encoded machine-readable payload. Both write to stdout so the
 * exit code (set by the caller from the {@link MachineOutput}) is the only
 * signal automation needs.
 *
 * @since 0.0.0
 */
import type { CliResult } from "./types.ts"

/**
 * Renders a {@link CliResult} to stdout.
 *
 * @since 0.0.0
 */
export const render = (result: CliResult, opts: { json: boolean }): void => {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`)
  } else {
    for (const line of result.human) {
      process.stdout.write(`${line}\n`)
    }
  }
}
