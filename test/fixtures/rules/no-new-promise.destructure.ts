// FAIL: destructuring the Promise global into an alias must still be caught.
const { Promise: P } = globalThis

export const destructured = new P<number>((resolve) => {
  resolve(1)
})
