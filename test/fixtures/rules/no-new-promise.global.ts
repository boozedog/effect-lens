// FAIL: `new global.Promise` is manual Promise construction.
export const globalForm = new global.Promise<number>((resolve) => {
  resolve(1)
})
