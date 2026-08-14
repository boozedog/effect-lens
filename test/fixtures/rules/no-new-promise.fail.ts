// FAIL: manual Promise construction.
export const direct = new Promise<number>((resolve) => {
  resolve(1)
})

export const globalThisForm = new globalThis.Promise<number>((resolve) => {
  resolve(1)
})
