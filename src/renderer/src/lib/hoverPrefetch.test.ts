import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_MS, Prefetcher, bootWarmTabs } from "./hoverPrefetch";

type Harness = {
  p: Prefetcher;
  loads: string[];
  resolve: (id: string) => void;
  loaded: Set<string>;
  online: { value: boolean };
};

function harness(): Harness {
  const loads: string[] = [];
  const resolvers = new Map<string, () => void>();
  const loaded = new Set<string>();
  const online = { value: true };
  const p = new Prefetcher({
    load: (id) => {
      loads.push(id);
      return new Promise<void>((r) => resolvers.set(id, r));
    },
    isLoaded: (id) => loaded.has(id),
    connected: () => online.value,
  });
  return {
    p,
    loads,
    loaded,
    online,
    resolve: (id) => {
      resolvers.get(id)?.();
      resolvers.delete(id);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("hover prefetch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a hover shorter than the dwell fetches nothing", () => {
    const h = harness();
    h.p.enter("a");
    vi.advanceTimersByTime(HOVER_MS - 1);
    h.p.leave("a");
    vi.advanceTimersByTime(HOVER_MS);
    expect(h.loads).toEqual([]);
  });

  it("dwelling fetches once; a loaded session is never fetched again", () => {
    const h = harness();
    h.p.enter("a");
    vi.advanceTimersByTime(HOVER_MS);
    expect(h.loads).toEqual(["a"]);
    h.p.leave("a");
    h.loaded.add("a");
    h.p.enter("a");
    vi.advanceTimersByTime(HOVER_MS);
    expect(h.loads).toEqual(["a"]);
  });

  it("moving to another tab restarts the dwell; only the last one fetches", () => {
    const h = harness();
    h.p.enter("a");
    vi.advanceTimersByTime(HOVER_MS - 10);
    h.p.enter("b", () => ["b1", "b2"]);
    vi.advanceTimersByTime(HOVER_MS - 10);
    expect(h.loads).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(h.loads).toEqual(["b1", "b2"]);
  });

  it("a stale leave does not cancel the newer hover", () => {
    const h = harness();
    h.p.enter("a");
    h.p.enter("b");
    h.p.leave("a");
    vi.advanceTimersByTime(HOVER_MS);
    expect(h.loads).toEqual(["b"]);
  });

  it("caps fetches in flight at two and frees a slot when one settles", async () => {
    const h = harness();
    expect(h.p.request("a")).toBe(true);
    expect(h.p.request("b")).toBe(true);
    expect(h.p.request("c")).toBe(false);
    expect(h.p.request("a")).toBe(false);
    expect(h.loads).toEqual(["a", "b"]);
    h.resolve("a");
    await flush();
    expect(h.p.inFlight.has("a")).toBe(false);
    expect(h.p.request("c")).toBe(true);
    expect(h.loads).toEqual(["a", "b", "c"]);
  });

  it("fetches nothing while the socket is down", () => {
    const h = harness();
    h.online.value = false;
    expect(h.p.request("a")).toBe(false);
    h.p.enter("b");
    vi.advanceTimersByTime(HOVER_MS);
    expect(h.loads).toEqual([]);
    h.online.value = true;
    expect(h.p.request("a")).toBe(true);
  });
});

describe("bootWarmTabs", () => {
  const tabs = [
    { id: "t1", sessionIds: ["s1"], updatedAt: 10 },
    { id: "t2", sessionIds: ["s2"], updatedAt: 50 },
    { id: "t3", sessionIds: ["s3", "s3b"], updatedAt: 30 },
    { id: "t4", sessionIds: ["s4"], updatedAt: 40 },
  ];

  it("prefers the visit trail, then the freshest tabs, never the active one", () => {
    expect(bootWarmTabs(tabs, "t2", ["t1"]).map((t) => t.id)).toEqual(["t1", "t4"]);
    expect(bootWarmTabs(tabs, "t2", []).map((t) => t.id)).toEqual(["t4", "t3"]);
    expect(bootWarmTabs(tabs, "t2", ["t2", "gone", "t3"]).map((t) => t.id)).toEqual(["t3", "t4"]);
  });

  it("returns fewer when there are fewer tabs", () => {
    expect(bootWarmTabs(tabs.slice(0, 1), "t1", []).length).toBe(0);
  });
});
