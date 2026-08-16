#!/usr/bin/env node
/*
 * One-command release for @boozedog/effect-lens (issue #16).
 *
 * Wraps the human release sequence so a maintainer does not have to type the
 * steps by hand: quality gate, dry-run preview, OTP-authenticated publish, and
 * the `v<version>` tag. It never hardcodes credentials, never publishes
 * without an explicit confirmation, and requires a clean tree on a release
 * branch.
 *
 * Usage:
 *   node scripts/release.mjs                 # interactive (prompts for OTP)
 *   node scripts/release.mjs --otp <CODE>    # non-interactive OTP
 *   node scripts/release.mjs --dry-run       # preview only (no publish/tag)
 *   node scripts/release.mjs --skip-verify   # skip the quality gate
 *
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { readFileSync, readSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
const name = pkg.name
const version = pkg.version

// --- CLI flags -------------------------------------------------------------
const args = process.argv.slice(2)
const otpIndex = args.indexOf("--otp")
const otp = otpIndex >= 0 ? args[otpIndex + 1] : undefined
const dryRun = args.includes("--dry-run")
const skipVerify = args.includes("--skip-verify")

// --- helpers ---------------------------------------------------------------
const run = (cmd, cmdArgs, opts = {}) => {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", cwd: repoRoot, ...opts })
  if (result.error) throw new Error(`failed to spawn ${cmd}: ${result.error.message}`)
  return result
}

const fail = (message) => {
  console.error(`\nrelease aborted: ${message}`)
  process.exit(1)
}

// Read one line from stdin synchronously (no async/await, per the repo's own
// Lens Effect-first rules). Blocks until the user presses Enter.
const readLine = (question) => {
  process.stdout.write(question)
  const buffer = Buffer.alloc(1024)
  const bytes = readSync(0, buffer, 0, buffer.length, null)
  return buffer.toString("utf8", 0, bytes).replace(/\r?\n$/, "").trim()
}

// --- 1. Preflight ----------------------------------------------------------
console.log(`\n== release ${name}@${version} ==`)

const status = run("git", ["status", "--porcelain"])
if (status.stdout.trim().length > 0) {
  fail("working tree is not clean; commit or stash changes first")
}

const branch = run("git", ["branch", "--show-current"]).stdout.trim()
if (branch !== "master") {
  fail(`not on a release branch (on '${branch}', expected 'master')`)
}

// --- 2. Quality gate --------------------------------------------------------
if (skipVerify) {
  console.log("== verify (skipped via --skip-verify) ==")
} else {
  console.log("== verify ==")
  const verify = run("nub", ["run", "verify"], { stdio: "inherit" })
  if (verify.status !== 0) fail("quality gate (nub run verify) failed")
}

// --- 3. Dry-run preview ----------------------------------------------------
console.log("== publish dry-run ==")
const preview = run("nub", ["publish", "--dry-run", "--access", "public"], { stdio: "inherit" })
if (preview.status !== 0) fail("publish dry-run failed")

if (dryRun) {
  console.log(`\nrelease dry-run complete: would publish ${name}@${version} (no upload, no tag)`)
  process.exit(0)
}

// --- 4. Confirm + OTP ------------------------------------------------------
const answer = readLine(
  `\nPublish ${name}@${version} to the public npm registry and tag v${version}? [y/N] `
)
const confirmed = answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
if (!confirmed) {
  fail("publish not confirmed")
}

let code = otp
if (!code) {
  code = readLine("Enter npm OTP (one-time password): ")
}
if (!code) {
  fail("no OTP provided")
}

// --- 5. Publish ------------------------------------------------------------
console.log("== publish ==")
const publish = run("nub", ["publish", "--access", "public", "--otp", code], { stdio: "inherit" })
if (publish.status !== 0) fail("publish failed")

// --- 6. Tag + push ---------------------------------------------------------
console.log("== tag ==")
const tag = `v${version}`
const tagResult = run("git", ["tag", tag])
if (tagResult.status !== 0) fail(`could not create tag ${tag}`)
const pushTag = run("git", ["push", "origin", tag])
if (pushTag.status !== 0) fail(`could not push tag ${tag}`)

console.log(`\nreleased ${name}@${version} and pushed tag ${tag}`)

