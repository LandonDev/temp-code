import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "monocode.tc.lastSeen";
const OLD_KEY = "thread-last-seen";
const FLOOR_KEY = "monocode.tc.seenFloor";

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
    vi.restoreAllMocks();
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

  it("prunes ids the server no longer knows, once, and notifies", async () => {
    const data = mockLocalStorage({ [KEY]: JSON.stringify({ keep: 5, gone: 6 }) });
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeLastSeen(listener);
    const before = mod.loadLastSeen();
    mod.pruneLastSeen(new Set(["keep", "other"]));
    expect(mod.loadLastSeen()).toEqual({ keep: 5 });
    expect(mod.loadLastSeen()).not.toBe(before);
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ keep: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    // Nothing to drop: no write, no notification.
    const stable = mod.loadLastSeen();
    mod.pruneLastSeen(new Set(["keep"]));
    expect(mod.loadLastSeen()).toBe(stable);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("adopts the old renderer's map when the new key is empty", async () => {
    const data = mockLocalStorage({ [OLD_KEY]: JSON.stringify({ a: 5, b: "x" }) });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ a: 5 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ a: 5 });
    expect(data.get(OLD_KEY)).toBeDefined();
  });

  it("leaves a populated new map alone", async () => {
    const data = mockLocalStorage({
      [KEY]: JSON.stringify({ n: 9 }),
      [OLD_KEY]: JSON.stringify({ a: 5 }),
    });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({ n: 9 });
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ n: 9 });
  });

  it("ignores a junk old value but still stamps the floor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const data = mockLocalStorage({ [OLD_KEY]: "not json" });
    const mod = await load();
    expect(mod.loadLastSeen()).toEqual({});
    expect(mod.seenFloor()).toBe(1234);
    expect(data.get(FLOOR_KEY)).toBe("1234");
    expect(data.has(KEY)).toBe(false);
  });

  it("writes the floor once and keeps it across reloads", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    mockLocalStorage();
    expect((await load()).seenFloor()).toBe(1000);
    now.mockReturnValue(2000);
    expect((await load()).seenFloor()).toBe(1000);
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
    expect(mod.seenFloor()).toBe(0);
  });
});
