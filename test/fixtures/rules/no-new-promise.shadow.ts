// PASS: a locally-declared `Promise` shadows the global, so `new Promise`
// refers to the local class and must NOT be flagged.
class Promise<T> {
  constructor(_executor: (resolve: (value: T) => void) => void) {}
}

export const local = new Promise<number>((resolve) => {
  resolve(1)
})
