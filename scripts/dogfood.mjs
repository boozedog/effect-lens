#!/usr/bin/env node
/**
 * Effect Lens self-dogfood check (issue #7).
 *
 * Runs the real `effect-lens` CLI against this repository's production source
 * and asserts the expected outcomes, so Effect Lens checks Effect Lens itself
 * in a reproducible, read-only project check.
 *
 * The check is strictly read-only: it never mutates source, config, packs, or
 * hooks. It reuses the real CLI process (spawned with Node's native type
 * stripping) rather than duplicating operations in a test-only implementation.
 *
 * Bootstrap boundary: this slice depends on the checked-out TypeScript source
 * (`src/cli/index.ts`), the local dependencies installed in `node_modules`
 * (for oxlint and the Effect runtime), and the committed reference-pack
 * fixture cache under `test/fixtures/cache`. It does not rely on the
 * developer's home cache or a `../effect` checkout.
 *
 * Usage:
 *   node scripts/dogfood.mjs [--project <dir>] [--cache <dir>] [--path <path>]
 *
 * Exits 0 when every self-check passes, 1 otherwise.
 *
 * @since 0.0.0
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ENTRY = join(repoRoot, "src", "cli", "index.ts")
const DEFAULT_CACHE = join(repoRoot, "test", "fixtures", "cache")
const DEFAULT_PATH = "src"

/**
 * The expected Effect version for a project, derived from its committed
 * `package.json` so the self-check does not hardcode a version that could
 * drift. Returns `null` when the project declares no `effect` dependency.
 *
 * @since 0.0.0
 */
const expectedEffectVersion = (projectDir) => {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"))
  } catch {
    return null
  }
  return pkg.devDependencies?.effect ?? pkg.dependencies?.effect ?? null
}

/**
 * Spawns the real CLI entrypoint with the given arguments and returns the
 * parsed JSON payload plus the process exit status. The CLI is spawned with
 * the repository as the working directory so oxlint resolves from the repo's
 * own `node_modules`.
 *
 * @since 0.0.0
 */
const runCli = (args) => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ENTRY, ...args],
    { encoding: "utf8", cwd: repoRoot }
  )
  const status = result.status ?? -1
  let json = null
  if (result.stdout.trim() !== "") {
    try {
      json = JSON.parse(result.stdout)
    } catch {
      json = null
    }
  }
  return { status, json, stderr: result.stderr }
}

/**
 * A single self-check outcome: the check name, whether it passed, and a
 * human-readable detail line.
 *
 * @since 0.0.0
 */
const check = (name, ok, detail) => ({ name, ok, detail })

/**
 * Snapshots the config files that `setup --dry-run` and `hooks status` inspect
 * so the self-check can prove those commands changed no project files.
 *
 * @since 0.0.0
 */
const snapshotConfig = (projectDir) => {
  const paths = [
    "package.json",
    ".oxlintrc.json",
    ".oxlintrc",
    "lefthook.yml",
    "lefthook.yaml",
    ".pre-commit-config.yaml",
    ".pre-commit-config.yml"
  ]
  const result = {}
  for (const rel of paths) {
    const p = join(projectDir, rel)
    if (existsSync(p)) result[rel] = readFileSync(p, "utf8")
  }
  // Snapshot any husky hook files so the read-only proof can see hook writes.
  const huskyDir = join(projectDir, ".husky")
  if (existsSync(huskyDir)) {
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p, rel)
        else if (entry.isFile()) result[rel] = readFileSync(p, "utf8")
      }
    }
    walk(huskyDir, ".husky")
  }
  return result
}

/**
 * True when two config snapshots are identical.
 *
 * @since 0.0.0
 */
const configsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Runs the three self-checks (doctor, drift, check) against a project and
 * returns the aggregate outcome. `expectedEffectVersion` defaults to the
 * project's declared `effect` specifier.
 *
 * @since 0.0.0
 */
export const runDogfood = (args) => {
  const projectDir = resolve(args.projectDir ?? repoRoot)
  const cacheDir = resolve(args.cacheDir ?? DEFAULT_CACHE)
  const path = args.path ?? DEFAULT_PATH
  const expected = args.expectedEffectVersion ?? expectedEffectVersion(projectDir)
  const checks = []
  const payloads = {}
  const configBefore = snapshotConfig(projectDir)

  // 1. doctor: resolved Effect identity and complete reference pack.
  const doctor = runCli(["doctor", "--project", projectDir, "--cache", cacheDir, "--json"])
  const doctorJson = doctor.json
  payloads.doctor = doctorJson
  const doctorOk =
    doctor.status === 0 &&
    doctorJson?.machineOutput?.status === 0 &&
    doctorJson?.resolution?.status === "resolved" &&
    doctorJson?.resolution?.expected?.version === expected &&
    doctorJson?.pack?.status === "complete"
  const expectedLabel = expected === null ? "a declared effect dependency" : `effect ${expected}`
  checks.push(
    check(
      "doctor",
      doctorOk,
      doctorOk
        ? `effect ${doctorJson.resolution.expected.version} resolved, pack ${doctorJson.pack.status}`
        : `expected ${expectedLabel} with a complete pack, got status ${doctor.status} ` +
            `(machine ${doctorJson?.machineOutput?.status ?? "n/a"}, ` +
            `resolution ${doctorJson?.resolution?.status ?? "n/a"}, ` +
            `pack ${doctorJson?.pack?.status ?? "n/a"})`
    )
  )

  // 2. drift: compatible local dependency and reference-pack state.
  const drift = runCli(["drift", "--project", projectDir, "--cache", cacheDir, "--json"])
  const driftJson = drift.json
  payloads.drift = driftJson
  const entries = driftJson?.report?.entries ?? []
  const driftOk =
    drift.status === 0 &&
    driftJson?.machineOutput?.status === 0 &&
    entries.length > 0 &&
    entries.every((entry) => entry.kind === "compatible")
  checks.push(
    check(
      "drift",
      driftOk,
      driftOk
        ? `${entries.length} compatible drift entr${entries.length === 1 ? "y" : "ies"}`
        : `expected all-compatible local drift, got status ${drift.status} ` +
            `(machine ${driftJson?.machineOutput?.status ?? "n/a"}, ` +
            `${entries.length} entr${entries.length === 1 ? "y" : "ies"})`
    )
  )

  // 3. check: zero Lens findings on the production source path.
  const checkRun = runCli([
    "check",
    "--project",
    projectDir,
    "--cache",
    cacheDir,
    "--path",
    path,
    "--json"
  ])
  const checkJson = checkRun.json
  payloads.check = checkJson
  const findings = checkJson?.machineOutput?.findings ?? []
  const files = checkJson?.oxlint?.files ?? 0
  const checkOk =
    checkRun.status === 0 &&
    checkJson?.machineOutput?.status === 0 &&
    findings.length === 0 &&
    files > 0
  checks.push(
    check(
      "check",
      checkOk,
      checkOk
        ? `${files} file(s) linted, 0 findings`
        : `expected 0 findings on ${path}, got status ${checkRun.status} ` +
            `(machine ${checkJson?.machineOutput?.status ?? "n/a"}, ` +
            `${findings.length} finding(s), ${files} file(s))`
    )
  )

  // 4. setup --dry-run: a read-only, well-formed plan with no file changes.
  const setup = runCli([
    "setup",
    "--dry-run",
    "--project",
    projectDir,
    "--cache",
    cacheDir,
    "--json"
  ])
  const setupJson = setup.json
  payloads.setup = setupJson
  const setupSteps = setupJson?.plan?.steps ?? []
  const setupReadOnly = configsEqual(configBefore, snapshotConfig(projectDir))
  const setupOk =
    setupReadOnly &&
    setupJson?.plan?.oxlint?.status === "configured" &&
    setupSteps.some((step) => step.id === "hooks")
  checks.push(
    check(
      "setup",
      setupOk,
      setupOk
        ? `${setupSteps.length} plan step(s), oxlint configured, read-only`
        : `expected a read-only setup plan, got status ${setup.status} ` +
            `(machine ${setupJson?.machineOutput?.status ?? "n/a"}, ` +
            `${setupSteps.length} step(s), read-only ${setupReadOnly})`
    )
  )

  // 5. hooks status: a read-only status report over known hook managers.
  const hooks = runCli([
    "hooks",
    "status",
    "--project",
    projectDir,
    "--cache",
    cacheDir,
    "--json"
  ])
  const hooksJson = hooks.json
  payloads.hooks = hooksJson
  const hooksReadOnly = configsEqual(configBefore, snapshotConfig(projectDir))
  const hooksManagers = hooksJson?.hooks?.managers ?? []
  const hooksOk =
    hooksReadOnly &&
    Array.isArray(hooksManagers) &&
    hooksManagers.length > 0 &&
    typeof hooksJson?.hooks?.lensStatus === "string"
  checks.push(
    check(
      "hooks",
      hooksOk,
      hooksOk
        ? `${hooksManagers.length} hook manager(s) reported, read-only`
        : `expected a read-only hooks status, got status ${hooks.status} ` +
            `(machine ${hooksJson?.machineOutput?.status ?? "n/a"}, ` +
            `${hooksManagers.length} manager(s), read-only ${hooksReadOnly})`
    )
  )

  return { ok: checks.every((c) => c.ok), checks, payloads }
}

/**
 * Renders the self-check summary to stdout and returns the process exit code.
 *
 * @since 0.0.0
 */
const render = (result) => {
  process.stdout.write("effect-lens self-dogfood\n")
  for (const c of result.checks) {
    process.stdout.write(`  ${c.ok ? "ok" : "FAILED"}: ${c.name} — ${c.detail}\n`)
  }
  if (result.ok) {
    process.stdout.write("self-dogfood passed\n")
    return 0
  }
  process.stdout.write("self-dogfood FAILED\n")
  return 1
}

// CLI entry: parse optional overrides and run the self-check.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const option = (flag) => {
    const index = argv.indexOf(flag)
    return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : undefined
  }
  const result = runDogfood({
    projectDir: option("--project"),
    cacheDir: option("--cache"),
    path: option("--path")
  })
  process.exitCode = render(result)
}
