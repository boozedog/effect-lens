#!/usr/bin/env node
/**
 * Effect Lens CLI entrypoint.
 *
 * A thin adapter over the shared core operations. It parses
 * arguments with Node's standard library, dispatches to the `doctor`, `drift`,
 * `check`, `setup`, `hooks`, and `packs` commands, renders human or JSON
 * output, and sets the process exit code from the resulting
 * {@link MachineOutput} (0 ok, 1 warning, 2 error). It never re-implements
 * policy; `setup --apply`, `hooks install|uninstall`, and `packs fetch` are
 * the explicit mutation paths; every other command is read-only.
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
import { hooks, hooksInstall, hooksUninstall } from "./commands/hooks.ts"
import { packsFetch, packsPlan } from "./commands/packs.ts"
import { setup, setupApply } from "./commands/setup.ts"
import { render } from "./output.ts"
import type { CliResult } from "./types.ts"
import { VERSION } from "./version.ts"

const USAGE = `effect-lens ${VERSION}
Usage: effect-lens <command> [options]

Commands:
  doctor   Report Effect resolution, installed mismatch, and reference-pack status.
  drift    Emit a local drift report over the Effect dependency and reference pack.
  check    Run the local read-only review path and aggregate findings.
  setup    Build a setup plan (requires --dry-run or --apply).
  hooks    Manage hook-manager checks (subcommand: status, install, uninstall).
  packs    Plan or explicitly fetch reference packs (subcommand: plan, fetch).

Options:
  -p, --project <dir>   Project directory (default: current directory)
  -c, --cache <dir>     Reference-pack cache directory
      --catalog <dir>   Reference-pack catalog baseline directory (packs only)
      --id <pack-id>    Exact catalog entry id to fetch (packs fetch only)
      --replace         Replace a divergent cached pack (packs fetch only)
  -j, --json            Emit machine-readable JSON output
      --path <path>     File or directory to lint (check only; relative to --project)
      --dry-run         Build a read-only setup plan (setup only)
      --apply           Apply the actionable setup plan (setup only; mutates)
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
    "dry-run"?: boolean
    apply?: boolean
    catalog?: string
    id?: string
    replace?: boolean
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
        "dry-run": { type: "boolean" },
        apply: { type: "boolean" },
        catalog: { type: "string" },
        id: { type: "string" },
        replace: { type: "boolean" },
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
    case "setup":
      if (values["dry-run"] === true && values.apply === true) {
        process.stderr.write(
          `error: --apply and --dry-run are mutually exclusive\n\n${USAGE}`
        )
        process.exitCode = Exit.Error
        return
      }
      if (values["dry-run"] === true) {
        result = setup({ projectDir, cacheDir })
      } else if (values.apply === true) {
        result = setupApply({ projectDir, cacheDir })
      } else {
        process.stderr.write(
          `error: setup requires an explicit mode: --dry-run (read-only) or ` +
            `--apply (mutating)\n\n${USAGE}`
        )
        process.exitCode = Exit.Error
        return
      }
      break
    case "hooks":
      if (positionals[1] === "install") {
        result = hooksInstall({ projectDir, cacheDir })
      } else if (positionals[1] === "uninstall") {
        result = hooksUninstall({ projectDir, cacheDir })
      } else if (positionals[1] === "status") {
        result = hooks({ projectDir, cacheDir })
      } else {
        process.stderr.write(
          `error: unknown hooks subcommand: ${positionals[1] ?? "(none)"}\n\n${USAGE}`
        )
        process.exitCode = Exit.Error
        return
      }
      break
    case "packs":
      if (positionals[1] === "plan") {
        if (values.catalog === undefined) {
          process.stderr.write(
            `error: packs plan requires --catalog <dir>\n\n${USAGE}`
          )
          process.exitCode = Exit.Error
          return
        }
        result = packsPlan({
          projectDir,
          cacheDir,
          catalogDir: resolve(values.catalog)
        })
      } else if (positionals[1] === "fetch") {
        if (values.catalog === undefined || values.id === undefined) {
          process.stderr.write(
            `error: packs fetch requires --catalog <dir> and --id <pack-id>\n\n${USAGE}`
          )
          process.exitCode = Exit.Error
          return
        }
        result = packsFetch({
          projectDir,
          cacheDir,
          catalogDir: resolve(values.catalog),
          packId: values.id,
          replace: values.replace === true
        })
      } else {
        process.stderr.write(
          `error: unknown packs subcommand: ${positionals[1] ?? "(none)"}\n\n${USAGE}`
        )
        process.exitCode = Exit.Error
        return
      }
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
