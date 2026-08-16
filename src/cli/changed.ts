/**
 * Reusable changed-file scope resolver for the read-only `check --changed`
 * surface (issue #14).
 *
 * Reads the staged (cached) changed paths from Git and, when a workspace
 * target is selected, filters them to the selected workspace's directory
 * tree. It is the reusable counterpart of the adoption audit's workspace
 * target resolution: the repository root (`projectDir`) remains the
 * config/lockfile boundary while only the staged paths inside the selected
 * workspace are returned for linting. It is strictly read-only and offline: it
 * only ever runs `git diff` and never mutates the index, working tree, or any
 * file.
 *
 * Staged paths are read with `git diff --cached --name-only --diff-filter=ACMR`
 * so deleted (`D`), renamed-away, and unstaged-only files are excluded; the
 * filter is the same set that pre-commit-style gates treat as lintable. Paths
 * the lint tool does not support (e.g. non-source files) are returned here but
 * skipped by the lint runner, so they never affect the result.
 *
 * @since 0.0.0
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { normalizeWorkspace, resolveWorkspaceDir } from "../Resolver.ts"

/**
 * The resolved changed-file scope.
 *
 * `files` are the absolute staged paths inside the selected workspace (all
 * staged paths when no workspace is selected), ready to hand to the lint
 * runner. `workspaceDir` is the resolved repo-relative workspace directory
 * (the raw target normalized when no importer matches) or `null` when no
 * workspace was selected. `error` is non-null when the staged paths could not
 * be read (git unavailable or not a repository), in which case `files` is
 * empty.
 *
 * @since 0.0.0
 */
export interface ChangedScope {
  readonly files: Array<string>
  readonly workspaceDir: string | null
  readonly error: string | null
}

/**
 * Resolves the staged changed-file scope for a project/workspace.
 *
 * Runs `git diff --cached --name-only --diff-filter=ACMR` from the project
 * directory and returns the matching staged paths as absolute paths, filtered
 * to the selected workspace when one is given. When git is unavailable or the
 * project is not a git repository, an error string is returned instead of
 * crashing.
 *
 * @since 0.0.0
 */
export const resolveChangedFiles = (args: {
  projectDir: string
  workspace?: string | undefined
}): ChangedScope => {
  const result = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    { cwd: args.projectDir, encoding: "utf8" }
  )
  if (result.error !== undefined) {
    return {
      files: [],
      workspaceDir: null,
      error: `git is unavailable: ${result.error.message}`
    }
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    return {
      files: [],
      workspaceDir: null,
      error: `git could not read staged paths: ${detail || "not a git repository?"}`
    }
  }
  // `-z` NUL-terminates entries, so paths with spaces/newlines and non-ASCII
  // names are returned verbatim (no C-style quoting) instead of being missed.
  const staged = result.stdout.split("\0").filter((entry) => entry !== "")
  let workspaceDir: string | null = null
  let files = staged
  if (args.workspace !== undefined && args.workspace !== "") {
    // Resolve the workspace target (full path or basename via the pnpm-lock
    // importers) to a repo-relative directory, falling back to the normalized
    // target when it cannot be matched — consistent with the adoption audit.
    // The resolved importer key is normalized (it may carry a leading `./`,
    // which `matchPnpmImporter` accepts) so the prefix matches git's
    // `packages/app/...`-style paths.
    workspaceDir = normalizeWorkspace(
      resolveWorkspaceDir(args.projectDir, args.workspace) ?? args.workspace
    )
    // A root-targeting workspace is not a scoped workspace; treat it as no
    // filter so the boundary is preserved rather than matching everything.
    if (workspaceDir !== "") {
      const prefix = `${workspaceDir}/`
      files = staged.filter((file) => file.startsWith(prefix))
    } else {
      workspaceDir = null
    }
  }
  return {
    files: files.map((file) => join(args.projectDir, file)),
    workspaceDir,
    error: null
  }
}
