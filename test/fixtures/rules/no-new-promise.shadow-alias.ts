// PASS: `const P = Promise` where `Promise` is a locally-shadowed class must
// NOT be treated as the global Promise.
class Promise<T> {
  constructor(_executor: (resolve: (value: T) => void) => void) {}
}

const P = Promise

export const local = new P<number>((resolve) => {
  resolve(1)
})
