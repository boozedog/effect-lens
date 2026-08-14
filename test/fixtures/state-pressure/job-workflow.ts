// Signal fixture: a discriminated union not named State/Status/Phase/Mode.
// Emits discriminated-union via the literal discriminant, but does not
// recommend on its own.
export type Job = { tag: "queued" } | { tag: "running" } | { tag: "done" }

export const next = (job: Job): Job => {
  switch (job.tag) {
    case "queued":
      return { tag: "running" }
    case "running":
      return { tag: "done" }
    case "done":
      return job
    default:
      return job
  }
}
