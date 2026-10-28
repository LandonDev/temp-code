import { describe, expect, it } from "vitest";
import {
  buildHeaderModel,
  headerNeighbour,
  headerOrder,
  holdDepartures,
  holdModel,
  orderChips,
  slotTarget,
  stripChips,
  type HeaderChip,
  type HeaderModel,
} from "./threadHeaderModel";
import type { StripThread } from "./threadStripModel";

const thread = (id: string, extra: Partial<StripThread> = {}): StripThread => ({
  id,
  status: "idle",
  updatedAt: 100,
  projectId: "p1",
  parentId: null,
  archived: false,
  ...extra,
});

const threads = [
  thread("run", { status: "running", updatedAt: 50 }),
  thread("wait", { status: "waiting", updatedAt: 70 }),
  thread("seen", { updatedAt: 30 }),
  thread("unread", { updatedAt: 90 }),
  thread("loose", { projectId: null, status: "running" }),
  thread("child", { parentId: "run", status: "running" }),
];
const tabs = [
  { id: "t-run", sessionIds: ["run", "child"] },
  { id: "t-seen", sessionIds: ["seen"] },
  { id: "t-files", sessionIds: [] },
];
const lastSeen = { run: 50, wait: 70, seen: 30, unread: 10 };

describe("buildHeaderModel", () => {
  it("makes chips from the project's roots whether or not a tab holds them", () => {
    const model = buildHeaderModel({
      threads,
      tabs,
      scope: { project: "p1" },
      activeTabId: "t-run",
      lastSeen,
      planReady: {},
    });
    expect(model.live.map((c) => c.id)).toEqual(["unread", "wait", "run"]);
    expect(model.dormant.map((c) => c.id)).toEqual(["seen"]);
    expect(model.live.map((c) => c.tabId)).toEqual([null, null, "t-run"]);
    expect(model.activeId).toBe("run");
  });

  it("two roots sharing the active tab: the focused one is the active chip", () => {
    const model = (sessionIds: string[]) =>
      buildHeaderModel({ threads, tabs: [{ id: "t-split", sessionIds }], scope: { project: "p1" }, activeTabId: "t-split", lastSeen, planReady: {} });
    expect(model(["wait", "run"]).activeId).toBe("wait");
    expect(model(["run", "wait"]).activeId).toBe("run");
    expect(model(["child", "wait", "run"]).activeId).toBe("wait");
  });

  it("carries the root's own status, the tree flags on its thread", () => {
    const model = buildHeaderModel({
      threads: [thread("x", { status: "running", treeHasPaused: true }), thread("y", { updatedAt: 200 })],
      tabs: [],
      scope: { project: "p1" },
      activeTabId: null,
      lastSeen: { x: 100, y: 100 },
      planReady: {},
    });
    expect(model.live.map((c) => [c.id, c.status, !!c.thread.treeHasPaused, c.unread])).toEqual([
      ["y", "idle", false, true],
      ["x", "running", true, false],
    ]);
  });

  it("has no chips without a project and no active chip when a file tab is up", () => {
    expect(
      buildHeaderModel({ threads, tabs, scope: { project: null }, activeTabId: "t-run", lastSeen, planReady: {} }),
    ).toEqual({ live: [], dormant: [], activeId: null });
    const model = buildHeaderModel({
      threads,
      tabs,
      scope: { project: "p1" },
      activeTabId: "t-files",
      lastSeen,
      planReady: {},
    });
    expect(model.activeId).toBeNull();
  });

  it("keeps a selected dormant chip on the shelf", () => {
    const model = buildHeaderModel({
      threads,
      tabs,
      scope: { project: "p1" },
      activeTabId: "t-seen",
      lastSeen,
      planReady: {},
    });
    expect(model.dormant.map((c) => c.id)).toEqual(["seen"]);
    expect(model.activeId).toBe("seen");
  });
});

describe("buildHeaderModel: the loose scope", () => {
  const catalog = {
    workspaces: [
      { id: "w1", path: "/w1" },
      { id: "w2", path: "/w2" },
    ],
    projects: [{ id: "p1", workspaceId: "w1" }],
  } as unknown as import("./projectContext").Catalog;
  const loose = [
    thread("chat-w1", { projectId: null, workspaceId: "w1", cwd: "/w1", status: "running" }),
    thread("chat-path", { projectId: null, workspaceId: null, cwd: "/w2", status: "waiting" }),
    thread("chat-home", { projectId: null, workspaceId: null, cwd: "/tmp", status: "running" }),
    thread("chat-sub", { projectId: null, workspaceId: "w1", cwd: "/w1", parentId: "chat-w1" }),
    thread("chat-batch", { projectId: null, workspaceId: "w1", cwd: "/w1", masterId: "m" }),
    thread("chat-gone", { projectId: null, workspaceId: "w1", cwd: "/w1", archived: true }),
    thread("proj", { workspaceId: "w1", cwd: "/w1", status: "running" }),
  ];
  const build = (looseId: string | null, extra: { activeTabId?: string; onScreenId?: string } = {}) =>
    buildHeaderModel({
      threads: loose,
      tabs: [{ id: "t-proj", sessionIds: ["proj"] }],
      scope: { loose: looseId, catalog },
      activeTabId: extra.activeTabId ?? null,
      onScreenId: extra.onScreenId,
      lastSeen: {},
      planReady: {},
    });

  it("holds a workspace's loose chats, by id or by path, and nothing of its projects", () => {
    expect(headerOrder(build("w1")).map((c) => c.id)).toEqual(["chat-w1"]);
    expect(headerOrder(build("w2")).map((c) => c.id)).toEqual(["chat-path"]);
  });

  it("holds the home's chats outside every workspace", () => {
    expect(headerOrder(build(null)).map((c) => c.id)).toEqual(["chat-home"]);
  });

  it("gives the thread on screen its chip when it is outside the scope", () => {
    const model = build("w2", { activeTabId: "t-proj", onScreenId: "proj" });
    expect(model.activeId).toBe("proj");
    expect(stripChips(model).map((c) => c.id)).toEqual(["chat-path", "proj"]);
    expect(model.dormant.find((c) => c.id === "proj")?.tabId).toBe("t-proj");
  });
});

describe("headerOrder and headerNeighbour", () => {
  const model = buildHeaderModel({
    threads,
    tabs,
    scope: { project: "p1" },
    activeTabId: null,
    lastSeen,
    planReady: {},
  });

  it("cycles the live row then the shelf", () => {
    expect(headerOrder(model).map((c) => c.id)).toEqual(["unread", "wait", "run", "seen"]);
  });

  it("hands selection to the same slot, or the last chip, or nobody", () => {
    expect(headerNeighbour(model, "wait")?.id).toBe("run");
    expect(headerNeighbour(model, "seen")?.id).toBe("run");
    expect(headerNeighbour(model, "missing")?.id).toBe("unread");
    const lone = buildHeaderModel({
      threads: [thread("only")],
      tabs: [],
      scope: { project: "p1" },
      activeTabId: null,
      lastSeen: {},
      planReady: {},
    });
    expect(headerNeighbour(lone, "only")).toBeNull();
  });
});

describe("orderChips", () => {
  const c = (id: string, updatedAt = 0) => ({ id, updatedAt });

  it("keeps the places of the ids it knows, whatever their status did", () => {
    expect(orderChips(["b", "a", "c"], [c("a", 9), c("b", 1), c("c", 5)])).toEqual(["b", "a", "c"]);
  });

  it("appends new ids at the end and drops the ones gone", () => {
    expect(orderChips(["a", "b"], [c("b"), c("n")])).toEqual(["b", "n"]);
  });

  it("orders a cold start by age, oldest first", () => {
    expect(orderChips([], [c("new", 30), c("old", 10), c("mid", 20)])).toEqual(["old", "mid", "new"]);
  });

  it("appends several arrivals oldest first after the known ones", () => {
    expect(orderChips(["a"], [c("y", 8), c("a"), c("x", 2)])).toEqual(["a", "x", "y"]);
  });
});

describe("holdDepartures", () => {
  it("holds a chip that left while the pointer is over the strip, then lets it go", () => {
    expect(holdDepartures(["a", "b", "c"], ["a", "c"], true)).toEqual(["a", "b", "c"]);
    expect(holdDepartures(["a", "b", "c"], ["a", "c"], false)).toEqual(["a", "c"]);
  });

  it("still lets a new chip join at the end while holding", () => {
    expect(holdDepartures(["a", "b"], ["a", "n"], true)).toEqual(["a", "b", "n"]);
  });
});

describe("holdModel and slotTarget", () => {
  const chipOf = (id: string, tabId: string | null): HeaderChip => ({
    id,
    thread: thread(id),
    tabId,
    live: true,
    status: "idle",
    unread: false,
    updatedAt: 100,
  });
  // "c" settled: it left the live row for the shelf; "e" has no tab.
  const settled: HeaderModel = {
    live: ["a", "b", "d", "e"].map((id) => chipOf(id, id === "e" ? null : `t-${id}`)),
    dormant: [{ ...chipOf("c", "t-c"), live: false }],
    activeId: "a",
  };
  const shown = ["a", "b", "c", "d", "e"];

  it("keeps a departed chip in its place while holding, and out of the shelf", () => {
    const held = holdModel(settled, shown, true);
    expect(held.live.map((c) => c.id)).toEqual(shown);
    expect(held.dormant).toEqual([]);
    expect(holdModel(settled, shown, false)).toBe(settled);
  });

  it("never holds a chip that is gone from the scope", () => {
    const gone = { ...settled, dormant: [] };
    expect(holdModel(gone, shown, true).live.map((c) => c.id)).toEqual(["a", "b", "d", "e"]);
  });

  it("picks the nth chip of the held row, tab or no tab", () => {
    const held = holdModel(settled, shown, true);
    expect(slotTarget(held, 2)).toBe("c");
    expect(slotTarget(held, 3)).toBe("d");
    expect(slotTarget(held, -1)).toBe("e");
    expect(slotTarget(held, 7)).toBeNull();
  });
});

describe("stripChips", () => {
  it("draws the live chips, and a dormant thread only when it is on screen", () => {
    const model = buildHeaderModel({
      threads,
      tabs,
      scope: { project: "p1" },
      activeTabId: "t-seen",
      lastSeen: { seen: 100, unread: 10 },
      planReady: {},
    });
    const drawn = stripChips(model).map((chip) => chip.id);
    expect(drawn).toContain("seen");
    expect(drawn).toEqual([...model.live.map((chip) => chip.id), "seen"]);
    const elsewhere = { ...model, activeId: null };
    expect(stripChips(elsewhere).map((chip) => chip.id)).toEqual(model.live.map((chip) => chip.id));
  });
});
