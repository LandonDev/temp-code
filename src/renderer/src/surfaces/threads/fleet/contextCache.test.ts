import { describe, expect, it, vi } from "vitest";
import { CONTEXT_POLL_MS, ContextCache, parseReading, readingPercent } from "./contextCache";

function fakeTimers() {
  const intervals = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  return {
    intervals,
    timers: {
      setInterval: (cb: () => void, ms: number) => {
        const id = next++;
        intervals.set(id, { cb, ms });
        return id;
      },
      clearInterval: (id: number) => void intervals.delete(id),
    },
    tick: () => {
      for (const { cb } of intervals.values()) cb();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("readingPercent", () => {
  it("rounds and clamps the server's percentage", () => {
    expect(readingPercent({ totalTokens: 10, maxTokens: 100, percentage: 41.6 })).toBe(42);
    expect(readingPercent({ totalTokens: 10, maxTokens: 100, percentage: 140 })).toBe(100);
  });
  it("is null without a window (cursor reports maxTokens 0)", () => {
    expect(readingPercent({ totalTokens: 10, maxTokens: 0, percentage: 0 })).toBeNull();
    expect(readingPercent(null)).toBeNull();
  });
  it("derives from tokens when percentage is missing", () => {
    expect(readingPercent({ totalTokens: 25, maxTokens: 100, percentage: NaN })).toBe(25);
  });
});

describe("parseReading", () => {
  it("accepts the driver shape and drops nulls", () => {
    expect(parseReading(null)).toBeNull();
    expect(parseReading({ categories: [] })).toBeNull();
    expect(parseReading({ totalTokens: 5, maxTokens: 10, percentage: 50, model: "m" })).toEqual({
      totalTokens: 5,
      maxTokens: 10,
      percentage: 50,
      model: "m",
    });
  });
});

describe("ContextCache", () => {
  it("fetches once on poll start, then every 20 s, and stops on release", async () => {
    const ft = fakeTimers();
    const fetcher = vi.fn(async () => ({ totalTokens: 1, maxTokens: 10, percentage: 10 }));
    const cache = new ContextCache(fetcher, ft.timers);
    const release = cache.poll("a");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...ft.intervals.values()][0]?.ms).toBe(CONTEXT_POLL_MS);
    ft.tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    release();
    expect(cache.polling("a")).toBe(false);
    ft.tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one poll per session across rows and never polls globally", () => {
    const ft = fakeTimers();
    const fetcher = vi.fn(async () => null);
    const cache = new ContextCache(fetcher, ft.timers);
    const r1 = cache.poll("a");
    const r2 = cache.poll("a");
    cache.poll("b");
    expect(ft.intervals.size).toBe(2);
    r1();
    expect(cache.polling("a")).toBe(true);
    r2();
    r2();
    expect(cache.polling("a")).toBe(false);
    expect(cache.polling("b")).toBe(true);
  });

  it("keeps the last reading through null replies and notifies on change only", async () => {
    let reply: unknown = { totalTokens: 1, maxTokens: 10, percentage: 10 };
    const cache = new ContextCache(async () => reply, fakeTimers().timers);
    const listener = vi.fn();
    cache.subscribe(listener);
    await cache.refresh("a");
    expect(cache.get("a")?.percentage).toBe(10);
    expect(listener).toHaveBeenCalledTimes(1);
    reply = null;
    await cache.refresh("a");
    expect(cache.get("a")?.percentage).toBe(10);
    await cache.refresh("a");
    reply = { totalTokens: 1, maxTokens: 10, percentage: 10 };
    await cache.refresh("a");
    expect(listener).toHaveBeenCalledTimes(1);
    reply = { totalTokens: 5, maxTokens: 10, percentage: 50 };
    await cache.refresh("a");
    expect(cache.get("a")?.percentage).toBe(50);
    expect(listener).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("swallows fetch failures", async () => {
    const cache = new ContextCache(async () => {
      throw new Error("down");
    }, fakeTimers().timers);
    await expect(cache.refresh("a")).resolves.toBeUndefined();
    expect(cache.get("a")).toBeNull();
  });
});
