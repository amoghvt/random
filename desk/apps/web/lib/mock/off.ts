/** Production stand-in for the mock handler: the bundler aliases `desk-mock` here unless NEXT_PUBLIC_MOCK=1. */
export function mockApi(route: string, _opts: unknown): Promise<unknown> {
  return Promise.reject(new Error(`Mock mode is not built into this bundle (${route})`));
}
