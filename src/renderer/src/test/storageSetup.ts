/**
 * Node 26 defines a `localStorage` global of its own, undefined without
 * --localstorage-file, and vitest's jsdom environment leaves it in place.
 * Loaded by both projects (vitest.config.ts): under a jsdom environment with
 * no storage, a plain in-memory one. A test that brings its own still wins.
 * Its methods live on the prototype and each item is an own property, as on
 * a real Storage, so `Object.keys(localStorage)` lists the keys alone (the
 * appearance test reads it that way; under Bun, jsdom's own storage stands).
 */
if (typeof window !== 'undefined' && globalThis.localStorage === undefined) {
  class MemoryStorage {
    [key: string]: unknown
    getItem(k: string): string | null {
      return Object.prototype.hasOwnProperty.call(this, k) ? String(this[k]) : null
    }
    setItem(k: string, v: string): void {
      this[k] = String(v)
    }
    removeItem(k: string): void {
      delete this[k]
    }
    clear(): void {
      for (const k of Object.keys(this)) delete this[k]
    }
    key(i: number): string | null {
      return Object.keys(this)[i] ?? null
    }
    get length(): number {
      return Object.keys(this).length
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: new MemoryStorage() as unknown as Storage
  })
}
