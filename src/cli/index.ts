#!/usr/bin/env node
/**
 * Effect Lens CLI entrypoint.
 *
 * A thin, read-only adapter over the shared core operations. It parses
 * arguments with Node's standard library, dispatches to the `doctor`, `drift`,
 * and `check` commands, renders human or JSON output, and sets the process
 * exit code from the resulting {@link MachineOutput} (0 ok, 1 warning,
 * 2 error). It never re-implements policy and never mutates the project.
 *
 * @since 0.0.0
 */
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { Exit } from "../ExitStatus.ts"
import { check } from "./commands/check.ts"
import { doctor } from "./commands/doctor.ts"
import { drift } from "./commands/drift.ts"
import { render } from "./output.ts"
import type { CliResult } from "./types.ts"
import { VERSION } from "./version.ts"

const USAGE = `effect-lens ${VERSION}
Usage: effect-lens <command> [options]

Commands:
  doctor   Report Effect resolution, installed mismatch, and reference-pack status.
  drift    Emit a local drift report over the Effect dependency and reference pack.
  check    Run the local read-only review path and aggregate findings.

Options:
  -p, --project <dir>   Project directory (default: current directory)
  -c, --cache <dir>     Reference-pack cache directory
  -j, --json            Emit machine-readable JSON output
      --path <path>     File or directory to lint (check only; relative to --project)
  -h, --help            Show this help
  -v, --version         Show the version
`

/**
 * The default reference-pack cache directory, honouring `XDG_CACHE_HOME`.
 *
 * @since 0.0.0
 */
const defaultCacheDir = (): string => {
  const base = process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache")
  return resolve(base, "effect-lens")
}

/**
 * Runs the CLI and sets the process exit code.
 *
 * @since 0.0.0
 */
const main = (): void => {
  let values: {
    project?: string
    cache?: string
    json?: boolean
    path?: string
    help?: boolean
    version?: boolean
  }
  let positionals: Array<string>
  try {
    // pnpm passes a literal `--` separator before script args; strip any
    // leading `--` so option parsing is unaffected.
    const rawArgs = process.argv.slice(2)
    const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs
    const parsed = parseArgs({
      args,
      options: {
        project: { type: "string", short: "p" },
        cache: { type: "string", short: "c" },
        json: { type: "boolean", short: "j" },
        path: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      },
      allowPositionals: true,
      strict: true
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${USAGE}`)
    process.exitCode = Exit.Error
    return
  }

  if (values.help === true) {
    process.stdout.write(USAGE)
    return
  }
  if (values.version === true) {
    process.stdout.write(`effect-lens ${VERSION}\n`)
    return
  }

  const command = positionals[0]
  if (command === undefined) {
    process.stderr.write(`error: missing command\n\n${USAGE}`)
    process.exitCode = Exit.Error
    return
  }

  const projectDir = resolve(values.project ?? ".")
  const cacheDir = resolve(values.cache ?? defaultCacheDir())
  const json = values.json === true

  let result: CliResult
  switch (command) {
    case "doctor":
      result = doctor({ projectDir, cacheDir })
      break
    case "drift":
      result = drift({ projectDir, cacheDir })
      break
    case "check":
      result = values.path === undefined
        ? check({ projectDir, cacheDir })
        : check({ projectDir, cacheDir, path: values.path })
      break
    default:
      process.stderr.write(`error: unknown command: ${command}\n\n${USAGE}`)
      process.exitCode = Exit.Error
      return
  }

  render(result, { json })
  process.exitCode = result.machineOutput.status
}

main()
