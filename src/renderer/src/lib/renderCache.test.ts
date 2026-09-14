import { describe, expect, it } from "vitest";
import { RenderCache, cacheKey } from "./renderCache";

describe("RenderCache", () => {
  it("misses, then hits, and counts both", () => {
    const c = new RenderCache<number>(10, 1000);
    expect(c.get("a")).toBeUndefined();
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.stores).toBe(1);
    expect(c.hits).toBe(1);
  });

  it("evicts the least recently used entry past the entry cap", () => {
    const c = new RenderCache<number>(2, 1000);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // a is now the most recent
    c.set("c", 3);
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.has("c")).toBe(true);
  });

  it("evicts by weight and refuses an entry heavier than the cache", () => {
    const c = new RenderCache<string>(100, 10);
    c.set("k1", "v", 4);
    c.set("k2", "v", 4);
    expect(c.weight).toBe(8);
    c.set("k3", "v", 4);
    expect(c.has("k1")).toBe(false);
    expect(c.weight).toBe(8);
    c.set("big", "v", 11);
    expect(c.has("big")).toBe(false);
    expect(c.size).toBe(2);
  });

  it("replacing a key keeps the weight honest", () => {
    const c = new RenderCache<string>(10, 100);
    c.set("k", "a", 5);
    c.set("k", "b", 7);
    expect(c.size).toBe(1);
    expect(c.weight).toBe(7);
    expect(c.get("k")).toBe("b");
  });

  it("a content change is a different key, so the old entry never answers", () => {
    const c = new RenderCache<string>(10, 1000);
    c.set(cacheKey("block-1", "hello"), "parsed hello");
    expect(c.get(cacheKey("block-1", "hello!"))).toBeUndefined();
    expect(c.get(cacheKey("block-1", "hello"))).toBe("parsed hello");
    expect(cacheKey("a", "b")).not.toBe(cacheKey("ab", ""));
  });

  it("defaults the weight to the key length", () => {
    const c = new RenderCache<number>(10, 1000);
    c.set("abcd", 1);
    expect(c.weight).toBe(4);
  });
});
