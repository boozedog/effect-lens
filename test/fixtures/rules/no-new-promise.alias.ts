// FAIL: an aliased Promise constructor must still be caught.
const P = Promise
const G = globalThis.Promise

export const aliased = new P<number>((resolve) => {
  resolve(1)
})

export const globalAliased = new G<number>((resolve) => {
  resolve(1)
})
