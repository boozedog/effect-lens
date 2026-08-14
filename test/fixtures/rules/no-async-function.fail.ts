// FAIL: async function declaration, expression, and arrow.
export async function declared(): Promise<number> {
  return 1
}

export const expressed = async function(): Promise<number> {
  return 1
}

export const arrowed = async (): Promise<number> => 1

export const method = {
  async run(): Promise<number> {
    return 1
  }
}
