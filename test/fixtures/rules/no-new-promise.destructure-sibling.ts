// Mixed: `P` is the Promise alias (flagged); `M` is a sibling binding in the
// same destructure and must NOT be treated as the Promise global.
const { Promise: P, Map: M } = globalThis

export const promiseAlias = new P<number>((resolve) => {
  resolve(1)
})

export const sibling = new M()
