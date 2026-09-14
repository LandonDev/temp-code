// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTabGroupLabels, saveTabGroupLabel } from "./tabGroups";

const KEY = "monocode:tab-group:labels";
const data = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => data.get(key) ?? null),
  setItem: (key: string, value: string) => void data.set(key, value),
  removeItem: (key: string) => void data.delete(key),
  clear: () => data.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

describe("tab group records", () => {
  beforeEach(() => {
    data.clear();
    storage.getItem.mockClear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });

  it("parses a record once and hands out copies", () => {
    data.set(KEY, JSON.stringify({ a: "Alpha" }));
    const first = loadTabGroupLabels();
    const second = loadTabGroupLabels();
    expect(first).toEqual({ a: "Alpha" });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    first.a = "changed";
    expect(loadTabGroupLabels().a).toBe("Alpha");
  });

  it("serves a write from the cache and persists it", () => {
    saveTabGroupLabel("b", "Beta");
    storage.getItem.mockClear();
    expect(loadTabGroupLabels()).toEqual({ b: "Beta" });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(JSON.parse(data.get(KEY) ?? "{}")).toEqual({ b: "Beta" });
  });

  it("re-reads after another window changes the key", () => {
    expect(loadTabGroupLabels()).toEqual({});
    data.set(KEY, JSON.stringify({ c: "Gamma" }));
    expect(loadTabGroupLabels()).toEqual({});
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(loadTabGroupLabels()).toEqual({ c: "Gamma" });
  });
});
