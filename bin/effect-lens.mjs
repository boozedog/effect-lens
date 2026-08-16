#!/usr/bin/env node
/**
 * Effect Lens CLI launcher.
 *
 * Runs the compiled JavaScript entrypoint (`dist/cli/index.js`). The package is
 * published with a build step that compiles the TypeScript source to plain
 * JavaScript, so the published CLI runs on any supported Node without native
 * type stripping (which Node does not apply to files under `node_modules`).
 * The child inherits stdio and its exit code is propagated.
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.js")

const result = spawnSync(
  process.execPath,
  [entry, ...process.argv.slice(2)],
  { stdio: "inherit" }
)

process.exit(result.status ?? 1)
