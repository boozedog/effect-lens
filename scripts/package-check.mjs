#!/usr/bin/env node
/**
 * Nub-native package publication check (issue #16).
 *
 * Verifies that the packed `effect-lens` artifact is self-contained and
 * runnable from a clean consumer fixture, without a source checkout and
 * without a globally installed Nub at runtime. It never publishes to a
 * registry.
 *
 * Steps:
 *   1. Build the compiled `dist/` output (`nub run build`).
 *   2. Run `nub pack --dry-run --json` and assert the intended contents:
 *      the CLI bin, the compiled runtime modules, `package.json`, and
 *      `README.md`; and that no development artifacts (tests, fixtures,
 *      docs, scripts, CI, source, caches, lockfiles) leak into the tarball.
 *   3. Run `nub pack --pack-destination <tmp>` to produce the tarball.
 *   4. Create a clean consumer fixture outside the repository, install the
 *      tarball with Nub, and run the CLI there (`--version`, `--help`, and a
 *      read-only `doctor`).
 *   5. Remove all temporary artifacts.
 *
 * The command exits `0` when every check passes and `1` otherwise.
 *
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const version = pkg.version
const tarballName = `effect-lens-${version}.tgz`

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts })
  if (result.error) throw new Error(`failed to spawn ${cmd}: ${result.error.message}`)
  return result
}

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
  console.log(`${ok ? "ok" : "FAIL"}  ${message}`)
}

// --- 1. Build the compiled output -------------------------------------------
console.log("== build ==")
const build = run("nub", ["run", "build"], { cwd: repoRoot })
if (build.status !== 0) {
  console.error(build.stderr || build.stdout)
  process.exit(1)
}

// --- 2. Dry-run content assertions ------------------------------------------
console.log("== dry-run contents ==")
const dryRun = run("nub", ["pack", "--dry-run", "--json"], { cwd: repoRoot })
if (dryRun.status !== 0) {
  console.error(dryRun.stderr || dryRun.stdout)
  process.exit(1)
}
const dryRunJson = JSON.parse(dryRun.stdout)
const entry = dryRunJson[0]
const paths = entry.files.map((f) => f.path)

check(entry.name === "effect-lens", `package name is effect-lens (got ${entry.name})`)
check(entry.version === version, `package version is ${version} (got ${entry.version})`)
check(entry.filename === tarballName, `tarball filename is ${tarballName} (got ${entry.filename})`)

const required = [
  "bin/effect-lens.mjs",
  "dist/cli/index.js",
  "dist/plugin/index.js",
  "dist/provider/index.js",
  "dist/rules/index.js",
  "package.json",
  "README.md",
  "LICENSE"
]
for (const path of required) {
  check(paths.includes(path), `tarball includes ${path}`)
}

const forbidden = [
  "test/",
  "docs/",
  "scripts/",
  ".github/",
  "src/",
  "node_modules/",
  "tsconfig",
  "vitest.config.ts",
  "dprint.json",
  ".oxlintrc.json",
  "waivers.json",
  "pnpm-lock.yaml",
  ".npmrc",
  ".tsbuildinfo"
]
for (const pattern of forbidden) {
  const leaked = paths.filter((p) => p.startsWith(pattern) || p.includes(pattern))
  check(leaked.length === 0, `tarball excludes ${pattern}${leaked.length ? ` (leaked: ${leaked.join(", ")})` : ""}`)
}

// --- 3. Produce the tarball --------------------------------------------------
console.log("== pack ==")
const packDir = mkdtempSync(join(tmpdir(), "effect-lens-pack-"))
const pack = run("nub", ["pack", "--pack-destination", packDir], { cwd: repoRoot })
if (pack.status !== 0) {
  console.error(pack.stderr || pack.stdout)
  process.exit(1)
}
const tarball = join(packDir, tarballName)
check(existsSync(tarball), `tarball written to ${tarball}`)

// --- 4. Clean consumer install + run ----------------------------------------
console.log("== clean consumer install ==")
const fixture = mkdtempSync(join(tmpdir(), "effect-lens-fixture-"))
writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify(
    {
      name: "effect-lens-consumer-fixture",
      private: true,
      type: "module",
      dependencies: {
        "effect-lens": `file:${tarball}`,
        "effect": "4.0.0-rc.109"
      }
    },
    null,
    2
  ) + "\n"
)
const install = run("nub", ["install"], { cwd: fixture })
if (install.status !== 0) {
  console.error(install.stderr || install.stdout)
  process.exit(1)
}

const bin = join(fixture, "node_modules", ".bin", "effect-lens")
check(existsSync(bin), `consumer bin resolved at ${bin}`)

const versionOut = run(bin, ["--version"], { cwd: fixture })
check(
  versionOut.status === 0 && versionOut.stdout.includes(`effect-lens ${version}`),
  `consumer CLI prints version ${version}`
)

const helpOut = run(bin, ["--help"], { cwd: fixture })
check(
  helpOut.status === 0 && helpOut.stdout.includes("Usage: effect-lens <command>"),
  "consumer CLI prints usage"
)

const doctorOut = run(bin, ["doctor"], { cwd: fixture })
check(
  doctorOut.stdout.includes("effect-lens doctor") &&
    [0, 1, 2].includes(doctorOut.status),
  "consumer CLI runs read-only doctor with a valid exit code"
)

// A known Lens violation so the default `check` (whole project dir) must
// report it. The fixture has a real `node_modules` (Nub isolated virtual
// store), so this also proves oxlint does not walk the dependency tree and
// does not die with ENOBUFS.
mkdirSync(join(fixture, "src"), { recursive: true })
writeFileSync(
  join(fixture, "src", "violation.ts"),
  "export async function foo(): Promise<number> {\n  return await Promise.resolve(1)\n}\n"
)
const checkOut = run(bin, ["check"], { cwd: fixture })
check(
  checkOut.stdout.includes("lens/no-async-function"),
  "consumer default check reports a known Lens finding"
)
check(
  !checkOut.stdout.includes("ENOBUFS") && !checkOut.stdout.includes("oxlint failed to start"),
  "consumer default check starts oxlint without ENOBUFS"
)
check(
  /linted 1 file\(s\)/.test(checkOut.stdout),
  "consumer default check lints only fixture sources (not the dependency tree)"
)

// --- 5. Cleanup ---------------------------------------------------------------
rmSync(packDir, { recursive: true, force: true })
rmSync(fixture, { recursive: true, force: true })

if (failures.length > 0) {
  console.error("\npackage check failed:")
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\npackage check passed")
