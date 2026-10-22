/**
 * Node 26 defines a `localStorage` global of its own, undefined without
 * --localstorage-file, and vitest's jsdom environment leaves it in place.
 * Loaded by both projects (vitest.config.ts): under a jsdom environment with
 * no storage, a plain in-memory one. A test that brings its own still wins.
 */
if (typeof window !== 'undefined' && globalThis.localStorage === undefined) {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size
      }
    } satisfies Storage
  })
}
