/**
 * Stable exit status and machine-readable result model shared by the CLI and
 * Git gates.
 *
 * @since 0.0.0
 */
import * as Schema from "effect/Schema"
import { Diagnostic, Finding } from "./Finding.ts"

/**
 * Named exit codes. `warning` and `error` are both non-zero so automation can
 * distinguish advisory output from blocking failures.
 *
 * @since 0.0.0
 */
export const Exit = {
  Ok: 0,
  Warning: 1,
  Error: 2
} as const

/**
 * @since 0.0.0
 */
export const ExitStatus = Schema.Literals([0, 1, 2])
export type ExitStatus = Schema.Schema.Type<typeof ExitStatus>

/**
 * The machine-readable result of a Lens run. CLI, pi, and Git gates all emit
 * this shape so output is stable and parseable.
 *
 * @since 0.0.0
 */
export class MachineOutput extends Schema.Class<MachineOutput>("MachineOutput")({
  status: ExitStatus,
  findings: Schema.Array(Finding),
  diagnostics: Schema.Array(Diagnostic)
}) {}

/**
 * Constructs a {@link MachineOutput} value.
 *
 * @since 0.0.0
 */
export const makeMachineOutput = (args: {
  status: ExitStatus
  findings?: Array<Finding>
  diagnostics?: Array<Diagnostic>
}): MachineOutput =>
  new MachineOutput({
    status: args.status,
    findings: args.findings ?? [],
    diagnostics: args.diagnostics ?? []
  })

/**
 * Computes the aggregate exit status from findings and diagnostics: any
 * `error` becomes `Error`, otherwise any `warning` becomes `Warning`, otherwise
 * `Ok`.
 *
 * @since 0.0.0
 */
export const aggregateStatus = (args: {
  findings: ReadonlyArray<Finding>
  diagnostics: ReadonlyArray<Diagnostic>
}): ExitStatus => {
  const hasError = [...args.findings, ...args.diagnostics].some((x) => x.severity === "error")
  const hasWarning = [...args.findings, ...args.diagnostics].some((x) => x.severity === "warning")
  return hasError ? Exit.Error : hasWarning ? Exit.Warning : Exit.Ok
}
