// PASS: the bridge allowlist is bind-aware, so an aliased or namespace import
// of the effect package is still allowed.
import { Effect as Eff } from "effect"
import * as EffNs from "effect"

export async function namedAlias(): Promise<number> {
  return await Eff.runPromise(Eff.succeed(1))
}

export async function namespaceAlias(): Promise<number> {
  return await EffNs.Effect.runPromise(EffNs.Effect.succeed(1))
}
