import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "monocode.tc.lastSeen";

function mockLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

async function load() {
  vi.resetModules();
  return import("./sessionSeen");
}

describe("sessionSeen", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads an empty map when nothing is stored or the value is junk", async () => {
    mockLocalStorage({ [KEY]: "not json" });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
  });

  it("keeps only finite numbers", async () => {
    mockLocalStorage({ [KEY]: JSON.stringify({ a: 5, b: "x", c: null }) });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ a: 5 });
  });

  it("marks a session seen, persists it, and keeps the newest time", async () => {
    const data = mockLocalStorage();
    const mod = await load();
    mod.markSessionSeen("s1", 100);
    mod.markSessionSeen("s1", 50);
    expect(mod.loadLastSeen()).toEqual({ s1: 100 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ s1: 100 });
  });

  it("returns the same snapshot until a write and notifies subscribers", async () => {
    mockLocalStorage();
    const mod = await load();
    const listener = vi.fn();
    const off = mod.subscribeLastSeen(listener);
    const before = mod.loadLastSeen();
    expect(mod.loadLastSeen()).toBe(before);
    mod.markSessionSeen("s2", 7);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mod.loadLastSeen()).not.toBe(before);
    off();
    mod.markSessionSeen("s3", 8);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("survives a storage that throws", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
    expect(() => mod.markSessionSeen("s1", 1)).not.toThrow();
    expect(mod.loadLastSeen()).toEqual({ s1: 1 });
  });
});
