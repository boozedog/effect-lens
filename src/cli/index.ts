#!/usr/bin/env node
/**
 * Effect Lens CLI entrypoint.
 *
 * A thin adapter over the shared core operations. It parses
 * arguments with Node's standard library, dispatches to the `doctor`, `drift`,
 * `check`, `setup`, `hooks`, `packs`, `adoption`, and `freshness` commands, renders human
 * or JSON output, and sets the process exit code from the resulting
 * {@link MachineOutput} (0 ok, 1 warning, 2 error). It never re-implements
 * policy; `setup --apply`, `hooks install|uninstall`, and `packs fetch` are
 * the explicit mutation paths; every other command (including `packs plan`,
 * `packs status`, and `freshness`) is read-only. `freshness` is the only
 * network-backed command; it is run with `Effect.runPromise`.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { Exit } from "../ExitStatus.ts"
import { type CheckMode, DEFAULT_CHECK_MODE } from "../provider/Provider.ts"
import { adoptionAudit } from "./commands/adoption.ts"
import { check } from "./commands/check.ts"
import { doctor } from "./commands/doctor.ts"
import { drift } from "./commands/drift.ts"
import { freshness } from "./commands/freshness.ts"
import { hooks, hooksInstall, hooksUninstall } from "./commands/hooks.ts"
import { packsFetch, packsPlan, packsStatus } from "./commands/packs.ts"
import { setup, setupApply } from "./commands/setup.ts"
import { render } from "./output.ts"
import type { CliContext, CliResult } from "./types.ts"
import { VERSION } from "./version.ts"

const USAGE = `effect-lens ${VERSION}
Usage: effect-lens <command> [options]

Commands:
  doctor   Report Effect resolution, installed mismatch, and reference-pack status.
  drift    Emit a local drift report over the Effect dependency and reference pack.
  check    Run the local read-only review path and aggregate findings.
  setup    Build a setup plan (requires --dry-run or --apply).
  hooks    Manage hook-manager checks (subcommand: status, install, uninstall).
  packs    Report, plan, or explicitly fetch reference packs (subcommand: status, plan, fetch).
  adoption  Build a read-only staged-adoption audit (subcommand: audit).
  freshness  Advise on the newest allowed Effect version and reference pack (network-backed).

Options:
  -p, --project <dir>   Project directory (default: current directory)
      --workspace <pkg> Explicit workspace/package target relative to --project
  -c, --cache <dir>     Reference-pack cache directory
      --catalog <dir>   Reference-pack catalog baseline directory (packs/freshness)
      --id <pack-id>    Exact catalog entry id to fetch (packs fetch only)
      --replace         Replace a divergent cached pack (packs fetch only)
      --cooldown-days <n>  Minimum release age in days before a candidate is recommended (freshness only)
      --registry <url>  Registry endpoint (freshness only; default https://registry.npmjs.org)
      --exclude <ver>   Exclude a version from recommendation (freshness only; repeatable)
  -j, --json            Emit machine-readable JSON output
      --path <path>     File or directory to lint (check only; relative to --project)
      --mode <mode>     Check gate mode: lens-only (default) or unified (check only)
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
    workspace?: string
    json?: boolean
    path?: string
    mode?: string
    "dry-run"?: boolean
    apply?: boolean
    catalog?: string
    id?: string
    replace?: boolean
    "cooldown-days"?: string
    registry?: string
    exclude?: Array<string>
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
        workspace: { type: "string" },
        json: { type: "boolean", short: "j" },
        path: { type: "string" },
        mode: { type: "string" },
        "dry-run": { type: "boolean" },
        apply: { type: "boolean" },
        catalog: { type: "string" },
        id: { type: "string" },
        replace: { type: "boolean" },
        "cooldown-days": { type: "string" },
        registry: { type: "string" },
        exclude: { type: "string", multiple: true },
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
  const context: CliContext = {
    projectDir,
    cacheDir,
    workspace: values.workspace
  }

  let result: CliResult
  switch (command) {
    case "doctor":
      result = doctor(context)
      break
    case "drift":
      result = drift(context)
      break
    case "check":
      if (values.mode !== undefined && values.mode !== "lens-only" && values.mode !== "unified") {
        process.stderr.write(
          `error: invalid --mode: ${values.mode} (expected lens-only or unified)\n\n${USAGE}`
        )
        process.exitCode = Exit.Error
        return
      }
      const mode: CheckMode = values.mode === "unified" ? "unified" : DEFAULT_CHECK_MODE
      result = values.path === undefined
        ? check({ projectDir, cacheDir, mode })
        : check({ projectDir, cacheDir, path: values.path, mode })
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
        result = setup(context)
      } else if (values.apply === true) {
        result = setupApply({ projectDir, cacheDir, workspace: context.workspace })
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
    case "freshness":
      Effect.runPromise(freshness({
        projectDir,
        cacheDir,
        workspace: context.workspace,
        ...(values.catalog === undefined ? {} : { catalogDir: resolve(values.catalog) }),
        ...(values["cooldown-days"] === undefined
          ? {}
          : { cooldownDays: Number(values["cooldown-days"]) || 0 }),
        ...(values.registry === undefined ? {} : { registryUrl: values.registry }),
        ...(values.exclude === undefined ? {} : { exclude: values.exclude })
      })).then(
        (freshnessResult) => {
          render(freshnessResult, { json })
          process.exitCode = freshnessResult.machineOutput.status
        },
        (err) => {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exitCode = Exit.Error
        }
      )
      return
    case "packs":
      if (positionals[1] === "status") {
        if (values.catalog === undefined) {
          process.stderr.write(
            `error: packs status requires --catalog <dir>\n\n${USAGE}`
          )
          process.exitCode = Exit.Error
          return
        }
        result = packsStatus({
          projectDir,
          cacheDir,
          catalogDir: resolve(values.catalog),
          workspace: context.workspace
        })
      } else if (positionals[1] === "plan") {
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
          catalogDir: resolve(values.catalog),
          workspace: context.workspace
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
    case "adoption":
      if (positionals[1] === "audit") {
        result = adoptionAudit(context)
      } else {
        process.stderr.write(
          `error: unknown adoption subcommand: ${positionals[1] ?? "(none)"}\n\n${USAGE}`
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
