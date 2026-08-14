// Negative fixture: a trivial status switch. This MUST NOT recommend.
export type Status = "idle" | "active" | "done"

export const label = (status: Status): string => {
  switch (status) {
    case "idle":
      return "Idle"
    case "active":
      return "Active"
    case "done":
      return "Done"
    default:
      return "Unknown"
  }
}
