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
 *   5. Create a workspace-style consumer fixture (issue #17) outside the
 *      repository, install the tarball with Nub, and exercise the real
 *      integration paths against the packed CLI: root-lockfile and selected
 *      workspace importer resolution, invalid/ambiguous workspace target
 *      rejection, a full workspace check that loads the consumer's own oxlint
 *      config and a deterministic plugin fixture (with provider provenance)
 *      while excluding an outside-workspace violation, a staged `--changed`
 *      scope that lints only the selected workspace's staged files and honors
 *      ignores, an actionable config/plugin failure (never a clean empty
 *      gate), and a hook install that discovers the local packed binary and
 *      generates a unified changed-scope command with the selected workspace.
 *   6. Remove all temporary artifacts in a `finally` block (success or
 *      failure) and verify they are gone.
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
const tarballName = `boozedog-effect-lens-${version}.tgz`

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

// A hard failure (build/pack/install) that cannot be recovered from. Throwing
// lets the top-level `finally` clean up every temporary artifact before the
// process exits non-zero.
const fail = (message) => {
  throw new Error(message)
}

// Every temporary directory created during the run, removed in the top-level
// `finally` on both success and failure.
const tempDirs = []

// The root pnpm-lockfile for the workspace consumer. It carries a root
// importer plus two same-basename workspace importers (`packages/app` and
// `apps/app`) so `app` is ambiguous while `packages/app` is an exact match.
// The `packages/app` importer pins a DIFFERENT effect version than the root
// (`4.0.0-beta.83` vs `4.0.0-rc.109`) so a `--workspace packages/app` doctor
// can only report the workspace importer's version — proving the selected
// importer was actually consulted rather than falling back to the root. The
// synthetic integrity values are never verified by Nub because the lockfile
// is written after `nub install` (Nub uses its own `nub.lock`).
const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

  packages/app:
    dependencies:
      effect:
        specifier: 4.0.0-beta.83
        version: 4.0.0-beta.83

  apps/app:
    dependencies:
      effect:
        specifier: 4.0.0-rc.109
        version: 4.0.0-rc.109

packages:

  effect@4.0.0-rc.109:
    resolution: {integrity: sha512-rc109integrity}
    dependencies:
      fast-check: 4.9.0

  effect@4.0.0-beta.83:
    resolution: {integrity: sha512-beta83integrity}
    dependencies:
      fast-check: 4.9.0
`

// A deterministic oxlint plugin fixture loaded through the consumer's own
// `.oxlintrc.json`. It registers `fixture/no-console`, which flags any
// `console.*` call. oxlint loads it via `jsPlugins` (dynamic import of the
// `.mjs` file), so the packed CLI exercises a real consumer plugin path.
const PLUGIN_FIXTURE = `export default {
  meta: { name: "fixture" },
  rules: {
    "no-console": {
      meta: { type: "suggestion", docs: { description: "no console" } },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type === "MemberExpression" &&
                node.callee.object.type === "Identifier" &&
                node.callee.object.name === "console") {
              context.report({ node, message: "no console.log" })
            }
          }
        }
      }
    }
  }
}
`

// A minimal hk.pkl with an inline `pre-commit` steps mapping, the shape the
// hook install targets. It is written into the temporary consumer only.
const HK_PKL = `hooks {
  ["pre-commit"] {
    steps {
      ["fmt"] { check = "hk fmt" }
    }
  }
}
`

// The consumer oxlint config that loads the plugin fixture and ignores the
// `ignored.ts` file, so the changed-file scope can prove ignores hold.
const CONSUMER_OXLINTRC = JSON.stringify({
  jsPlugins: ["./plugin-fixture.mjs"],
  rules: { "fixture/no-console": "error" },
  ignorePatterns: ["**/ignored.ts", "**/node_modules/**"]
}, null, 2) + "\n"

try {
  // --- 1. Build the compiled output -----------------------------------------
  console.log("== build ==")
  const build = run("nub", ["run", "build"], { cwd: repoRoot })
  if (build.status !== 0) fail(`build failed:\n${build.stderr || build.stdout}`)

  // --- 2. Dry-run content assertions ----------------------------------------
  console.log("== dry-run contents ==")
  const dryRun = run("nub", ["pack", "--dry-run", "--json"], { cwd: repoRoot })
  if (dryRun.status !== 0) fail(`dry-run pack failed:\n${dryRun.stderr || dryRun.stdout}`)
  const dryRunJson = JSON.parse(dryRun.stdout)
  const entry = dryRunJson[0]
  const paths = entry.files.map((f) => f.path)

  check(entry.name === "@boozedog/effect-lens", `package name is @boozedog/effect-lens (got ${entry.name})`)
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

  // --- 3. Produce the tarball ------------------------------------------------
  console.log("== pack ==")
  const packDir = mkdtempSync(join(tmpdir(), "effect-lens-pack-"))
  tempDirs.push(packDir)
  const pack = run("nub", ["pack", "--pack-destination", packDir], { cwd: repoRoot })
  if (pack.status !== 0) fail(`pack failed:\n${pack.stderr || pack.stdout}`)
  const tarball = join(packDir, tarballName)
  check(existsSync(tarball), `tarball written to ${tarball}`)

  // --- 4. Clean consumer install + run --------------------------------------
  console.log("== clean consumer install ==")
  const fixture = mkdtempSync(join(tmpdir(), "effect-lens-fixture-"))
  tempDirs.push(fixture)
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "effect-lens-consumer-fixture",
        private: true,
        type: "module",
        dependencies: {
          "@boozedog/effect-lens": `file:${tarball}`,
          "effect": "4.0.0-rc.109"
        }
      },
      null,
      2
    ) + "\n"
  )
  const install = run("nub", ["install"], { cwd: fixture })
  if (install.status !== 0) fail(`clean consumer install failed:\n${install.stderr || install.stdout}`)

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

  // --- 5. Workspace-style consumer E2E (issue #17) ---------------------------
  console.log("== workspace consumer E2E ==")
  const wsFixture = mkdtempSync(join(tmpdir(), "effect-lens-ws-fixture-"))
  tempDirs.push(wsFixture)

  // Root manifest: install the packed tarball plus a real effect dependency.
  writeFileSync(
    join(wsFixture, "package.json"),
    JSON.stringify(
      {
        name: "effect-lens-ws-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@boozedog/effect-lens": `file:${tarball}`,
          "effect": "4.0.0-rc.109"
        }
      },
      null,
      2
    ) + "\n"
  )
  // Install first (Nub reads package.json and writes its own nub.lock); the
  // pnpm-lock.yaml is written afterwards so Nub never verifies its synthetic
  // integrity values.
  const wsInstall = run("nub", ["install"], { cwd: wsFixture })
  if (wsInstall.status !== 0) fail(`workspace consumer install failed:\n${wsInstall.stderr || wsInstall.stdout}`)
  const wsBin = join(wsFixture, "node_modules", ".bin", "effect-lens")
  check(existsSync(wsBin), `workspace consumer bin resolved at ${wsBin}`)

  // Root lockfile + workspace package + consumer config/plugin + sources.
  writeFileSync(join(wsFixture, "pnpm-lock.yaml"), PNPM_LOCK)
  mkdirSync(join(wsFixture, "packages/app/src"), { recursive: true })
  writeFileSync(
    join(wsFixture, "packages/app/package.json"),
    JSON.stringify({ name: "app", version: "0.0.0", dependencies: { effect: "4.0.0-beta.83" } }, null, 2) + "\n"
  )
  writeFileSync(join(wsFixture, ".oxlintrc.json"), CONSUMER_OXLINTRC)
  writeFileSync(join(wsFixture, "plugin-fixture.mjs"), PLUGIN_FIXTURE)
  mkdirSync(join(wsFixture, "src"), { recursive: true })
  writeFileSync(
    join(wsFixture, "src/root-violation.ts"),
    "async function rootAsync() { return 1 }\nvoid rootAsync\n"
  )
  writeFileSync(
    join(wsFixture, "packages/app/src/app-violation.ts"),
    "async function appAsync() { return 1 }\nconsole.log(\"hi\")\nvoid appAsync\n"
  )
  writeFileSync(
    join(wsFixture, "packages/app/src/ignored.ts"),
    "async function ignoredAsync() { return 1 }\nvoid ignoredAsync\n"
  )
  writeFileSync(join(wsFixture, "packages/app/src/clean.ts"), "const x = 1\nvoid x\n")

  // Root lockfile + workspace importer resolution.
  const doctorRoot = run(wsBin, ["doctor"], { cwd: wsFixture })
  check(
    [0, 1, 2].includes(doctorRoot.status) && doctorRoot.stdout.includes("4.0.0-rc.109 (lockfile)"),
    "workspace consumer doctor resolves the root importer from the root lockfile"
  )
  const doctorWs = run(wsBin, ["doctor", "--workspace", "packages/app"], { cwd: wsFixture })
  check(
    [0, 1, 2].includes(doctorWs.status) && doctorWs.stdout.includes("4.0.0-beta.83 (lockfile)"),
    "workspace consumer doctor resolves the selected workspace importer from the root lockfile"
  )

  // Invalid and ambiguous workspace targets are rejected (full check).
  const invalidWs = run(wsBin, ["check", "--mode", "unified", "--workspace", "nonexistent"], { cwd: wsFixture })
  check(
    invalidWs.status === 2 && invalidWs.stdout.includes("does not match any importer"),
    "full check rejects an unresolved workspace target with exit 2"
  )
  const ambiguousWs = run(wsBin, ["check", "--mode", "unified", "--workspace", "app"], { cwd: wsFixture })
  check(
    ambiguousWs.status === 2 && ambiguousWs.stdout.includes("is ambiguous") &&
      ambiguousWs.stdout.includes("packages/app, apps/app"),
    "full check rejects an ambiguous workspace target with exit 2"
  )

  // Full workspace check: loads the consumer config/plugin, reports the Lens
  // finding with provider provenance, and excludes the outside-workspace root
  // violation.
  const fullWs = run(wsBin, ["check", "--mode", "unified", "--workspace", "packages/app"], { cwd: wsFixture })
  check(
    fullWs.status === 2 && fullWs.stdout.includes("lens/no-async-function") &&
      fullWs.stdout.includes("(lens)"),
    "full workspace check reports the Lens finding with provider provenance"
  )
  check(
    fullWs.stdout.includes("fixture(no-console)"),
    "full workspace check loads the consumer plugin fixture and reports its diagnostic"
  )
  check(
    !fullWs.stdout.includes("root-violation"),
    "full workspace check excludes the outside-workspace root violation"
  )
  const fullWsJson = run(
    wsBin,
    ["check", "--mode", "unified", "--workspace", "packages/app", "--json"],
    { cwd: wsFixture }
  )
  check(
    fullWsJson.stdout.includes('"provider": "lens"'),
    "full workspace check reports provider provenance lens in JSON"
  )

  // Staged changed-file scope: only the selected workspace's staged files are
  // linted, the root staged file is excluded, and configured ignores hold.
  const git = (dir, ...args) => run("git", args, { cwd: dir })
  git(wsFixture, "init", "-q")
  git(wsFixture, "config", "user.email", "test@example.com")
  git(wsFixture, "config", "user.name", "test")
  git(
    wsFixture,
    "add",
    "packages/app/src/app-violation.ts",
    "packages/app/src/clean.ts",
    "packages/app/src/ignored.ts",
    "src/root-violation.ts"
  )
  const changedWs = run(
    wsBin,
    ["check", "--mode", "unified", "--workspace", "packages/app", "--changed"],
    { cwd: wsFixture }
  )
  check(
    changedWs.stdout.includes("3 changed file(s)") && !changedWs.stdout.includes("root-violation"),
    "changed scope includes only the selected workspace staged files"
  )
  check(
    changedWs.stdout.includes("linted 2 file(s)"),
    "changed scope honors the consumer config ignores"
  )
  check(
    changedWs.stdout.includes("lens/no-async-function (lens) packages/app/src/app-violation.ts") &&
      !changedWs.stdout.includes("lens/no-async-function (lens) packages/app/src/ignored.ts"),
    "changed scope reports the finding on the selected workspace file, not the ignored file"
  )

  // Config/plugin failure: a broken plugin must surface actionable metadata
  // and never look like a clean empty gate.
  writeFileSync(
    join(wsFixture, ".oxlintrc.json"),
    JSON.stringify({ jsPlugins: ["./broken-plugin.mjs"], rules: { "fixture/no-console": "error" } }, null, 2) + "\n"
  )
  writeFileSync(join(wsFixture, "broken-plugin.mjs"), "export default { this is not valid javascript\n")
  const broken = run(
    wsBin,
    ["check", "--mode", "unified", "--workspace", "packages/app", "--json"],
    { cwd: wsFixture }
  )
  check(
    broken.status === 1 && broken.stdout.includes("Failed to load JS plugin") &&
      broken.stdout.includes("exit 1") && broken.stdout.includes("check-oxlint-unavailable"),
    "config/plugin failure surfaces actionable stderr/status metadata, not a clean gate"
  )
  // Restore the good config for the hook test.
  writeFileSync(join(wsFixture, ".oxlintrc.json"), CONSUMER_OXLINTRC)

  // Hook install: the local packed binary is discovered and the generated hk
  // command includes the unified changed scope and the selected workspace.
  writeFileSync(join(wsFixture, "hk.pkl"), HK_PKL)
  const hookInstall = run(wsBin, ["hooks", "install", "--workspace", "packages/app"], { cwd: wsFixture })
  check(
    hookInstall.status === 0 && hookInstall.stdout.includes("outcome: applied"),
    "hook install applies against the temporary hk.pkl"
  )
  const hkContent = readFileSync(join(wsFixture, "hk.pkl"), "utf8")
  check(
    hkContent.includes("check --mode unified --changed --workspace 'packages/app'"),
    "generated hk command includes unified changed scope and the selected workspace"
  )
  check(
    hkContent.includes(wsBin),
    "local packed binary is discoverable for hook installation"
  )
  // Spawn the generated hk command from the consumer cwd and assert it runs
  // the unified changed-scope check (issue #17 item 5: generated-command
  // behavior, not just a string match).
  const cmdMatch = /\["effect-lens"\]\s*\{\s*check = "((?:[^"\\]|\\.)*)"/.exec(hkContent)
  const hookCommand = cmdMatch === null ? null : cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  const hookRun = hookCommand === null
    ? { status: -1, stdout: "" }
    : run("sh", ["-c", hookCommand], { cwd: wsFixture })
  check(
    hookRun.status === 2 && hookRun.stdout.includes("lens/no-async-function"),
    "generated hk command runs the unified changed-scope check"
  )

  if (failures.length > 0) {
    fail("package check failed:\n  - " + failures.join("\n  - "))
  }
  console.log("\npackage check passed")
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  // --- 6. Cleanup (success and failure) --------------------------------------
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Verify every temporary directory and tarball was removed.
for (const dir of tempDirs) {
  if (existsSync(dir)) {
    console.error(`FAIL  temporary dir not removed: ${dir}`)
    process.exitCode = 1
  } else {
    console.log(`ok  temporary dir removed: ${dir}`)
  }
}
