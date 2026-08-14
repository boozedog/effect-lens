#!/usr/bin/env node
/**
 * Effect Lens CLI launcher.
 *
 * Runs the TypeScript entrypoint with Node's native type stripping. The
 * `--experimental-strip-types` flag is accepted on Node 22.6+ and is a no-op on
 * Node 23.6+ (where type stripping is enabled by default), so this launcher
 * works across the supported Node range. The child inherits stdio and its exit
 * code is propagated.
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts")

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", entry, ...process.argv.slice(2)],
  { stdio: "inherit" }
)

process.exit(result.status ?? 1)
