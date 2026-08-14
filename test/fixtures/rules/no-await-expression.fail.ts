// FAIL: await on a non-bridge value.
export async function bad(): Promise<number> {
  const value = await Promise.resolve(1)
  return value
}

export async function badCall(): Promise<number> {
  return await fetch("https://example.com").then((r) => r.status)
}
