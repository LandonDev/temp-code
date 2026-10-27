import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  header,
  headerStore,
  initialHeaderState,
  loadStripOrder,
  publish,
  STRIP_ORDER_CAP,
  STRIP_ORDER_TTL_MS,
  stripOrder,
  tabProjectOf,
} from "./header";

describe("header publish", () => {
  it("keeps the state object when every field is the same", () => {
    const s = initialHeaderState();
    expect(publish(s, { ...s })).toBe(s);
  });

  it("takes only the fields that changed", () => {
    const s = initialHeaderState();
    const stripTabs = ["a", "b"];
    const next = publish(s, { ...s, stripTabs });
    expect(next).not.toBe(s);
    expect(next.stripTabs).toBe(stripTabs);
    expect(next.tabProjects).toBe(s.tabProjects);
    expect(next.model).toBe(s.model);
    expect(next.chipThreads).toBe(s.chipThreads);
  });

  it("the bound publish notifies only on a change and exposes tab projects", () => {
    headerStore.setState(initialHeaderState(), true);
    let notified = 0;
    const off = headerStore.subscribe(() => notified++);
    header.publish(headerStore.getState());
    expect(notified).toBe(0);
    header.publish({ ...headerStore.getState(), tabProjects: new Map([["t1", "repo"]]) });
    expect(notified).toBe(1);
    expect(tabProjectOf("t1")).toBe("repo");
    expect(tabProjectOf("t2")).toBeUndefined();
    off();
  });
});

describe("strip order", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    clear: () => data.clear(),
  };
  beforeEach(() => {
    vi.stubGlobal("localStorage", storage);
    data.clear();
    storage.setItem.mockClear();
    stripOrder.reload();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists per project and reloads", () => {
    stripOrder.set("p1", ["b", "a"]);
    stripOrder.set("p2", ["z"]);
    stripOrder.reload();
    expect(stripOrder.of("p1")).toEqual(["b", "a"]);
    expect(stripOrder.of("p2")).toEqual(["z"]);
    expect(stripOrder.of("p3")).toEqual([]);
  });

  it("keeps at most the cap, newest arrivals last", () => {
    const ids = Array.from({ length: STRIP_ORDER_CAP + 5 }, (_, i) => `t${i}`);
    stripOrder.set("p1", ids);
    expect(stripOrder.of("p1")).toHaveLength(STRIP_ORDER_CAP);
    expect(stripOrder.of("p1").at(-1)).toBe(`t${STRIP_ORDER_CAP + 4}`);
  });

  it("drops a project not shown for 30 days on load, and ignores a corrupt value", () => {
    const now = 10 * STRIP_ORDER_TTL_MS;
    stripOrder.set("old", ["a"], now - STRIP_ORDER_TTL_MS - 1);
    stripOrder.set("fresh", ["b"], now - 1000);
    expect(Object.keys(loadStripOrder(now))).toEqual(["fresh"]);
    localStorage.setItem("monocode.stripOrder", "{not json");
    expect(loadStripOrder(now)).toEqual({});
  });

  it("two copies of a linked project share one order through the leader's key", () => {
    stripOrder.set("leader", ["mac-thread", "box-thread"]);
    expect(stripOrder.of("leader")).toEqual(["mac-thread", "box-thread"]);
  });

  it("an unchanged order writes nothing", () => {
    stripOrder.set("p1", ["a"]);
    storage.setItem.mockClear();
    stripOrder.set("p1", ["a"]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
