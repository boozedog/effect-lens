/**
 * The Effect Lens CLI version, read from the package manifest so it never
 * drifts from the published version.
 *
 * @since 0.0.0
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json"
)

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }

/**
 * @since 0.0.0
 */
export const VERSION: string = packageJson.version
