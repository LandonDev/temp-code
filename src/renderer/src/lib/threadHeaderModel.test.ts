import { describe, expect, it } from "vitest";
import {
  archiveNeighbour,
  buildHeaderModel,
  headerOrder,
  holdDepartures,
  holdModel,
  orderChips,
  orderModel,
  rootOf,
  saveIds,
  slotTarget,
  tabRoot,
  type HeaderChip,
  type HeaderModel,
} from "./threadHeaderModel";
import { looseScopeOf, type StripThread } from "./threadStripModel";

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
    // A focused subagent selects its root, not the next pane's thread.
    expect(model(["child", "wait", "run"]).activeId).toBe("run");
    // A focused file pane: the tab's first thread.
    expect(model(["file:1", "wait", "run"]).activeId).toBe("wait");
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

  it("has only the thread on screen without a project, and no active chip when a file tab is up", () => {
    expect(
      buildHeaderModel({ threads, tabs, scope: { project: null }, activeTabId: null, lastSeen, planReady: {} }),
    ).toEqual({ live: [], dormant: [], activeId: null, outsideId: null });
    const onScreen = buildHeaderModel({ threads, tabs, scope: { project: null }, activeTabId: "t-run", lastSeen, planReady: {} });
    expect(onScreen.live.map((c) => c.id)).toEqual(["run"]);
    expect(onScreen.outsideId).toBe("run");
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
  const build = (looseId: string | null, extra: { activeTabId?: string } = {}) =>
    buildHeaderModel({
      threads: loose,
      tabs: [{ id: "t-proj", sessionIds: ["proj"] }],
      scope: { loose: looseId ? new Set([looseId]) : null, catalog },
      activeTabId: extra.activeTabId ?? null,
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

  it("gives the thread on screen its chip at the live row's end when it is outside the scope", () => {
    const model = orderModel(build("w2", { activeTabId: "t-proj" }), ["proj"]);
    expect(model.activeId).toBe("proj");
    expect(model.outsideId).toBe("proj");
    expect(model.live.map((c) => c.id)).toEqual(["chat-path", "proj"]);
    expect(model.live.at(-1)?.tabId).toBe("t-proj");
    // It is never saved into the scope's order.
    expect(saveIds(model)).toEqual(["chat-path"]);
  });

  it("holds a linked copy's loose chats beside the workspace's own", () => {
    const linked = {
      workspaces: [
        { id: "wm", path: "/mac", linkId: "L" },
        { id: "wb", path: "/box", linkId: "L" },
        { id: "wo", path: "/other" },
      ],
      projects: [],
    } as unknown as import("./projectContext").Catalog;
    const scope = looseScopeOf("wm", linked);
    expect([...(scope ?? [])].sort()).toEqual(["wb", "wm"]);
    expect(looseScopeOf(null, linked)).toBeNull();
    const model = buildHeaderModel({
      threads: [
        thread("remote", { projectId: null, workspaceId: "wb", cwd: "/box", status: "running" }),
        thread("here", { projectId: null, workspaceId: "wm", cwd: "/mac", status: "running" }),
        thread("other", { projectId: null, workspaceId: "wo", cwd: "/other", status: "running" }),
      ],
      tabs: [],
      scope: { loose: scope, catalog: linked },
      activeTabId: null,
      lastSeen: {},
      planReady: {},
    });
    expect(model.live.map((c) => c.id).sort()).toEqual(["here", "remote"]);
  });
});

describe("headerOrder and archiveNeighbour", () => {
  const model = buildHeaderModel({
    threads,
    tabs,
    scope: { project: "p1" },
    activeTabId: null,
    lastSeen,
    planReady: {},
  });
  const active = (id: string) => ({ ...model, activeId: id });

  it("cycles the live row then the shelf", () => {
    expect(headerOrder(model).map((c) => c.id)).toEqual(["unread", "wait", "run", "seen"]);
  });

  it("hands selection to the next chip of the same row, else the one before", () => {
    expect(archiveNeighbour(active("wait"), "wait")?.id).toBe("run");
    expect(archiveNeighbour(active("run"), "run")?.id).toBe("wait");
  });

  it("crosses to the other row only when its own is left empty", () => {
    expect(archiveNeighbour(active("seen"), "seen")?.id).toBe("unread");
    const lone = buildHeaderModel({
      threads: [thread("only")],
      tabs: [],
      scope: { project: "p1" },
      activeTabId: null,
      lastSeen: {},
      planReady: {},
    });
    expect(archiveNeighbour({ ...lone, activeId: "only" }, "only")).toBeNull();
  });

  it("selects nothing when the archived chip was not the active one", () => {
    expect(archiveNeighbour(model, "wait")).toBeNull();
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

describe("the two rows", () => {
  const roots = [
    thread("a", { status: "running", updatedAt: 40 }),
    thread("b", { updatedAt: 90 }),
    thread("c", { updatedAt: 60 }),
    thread("d", { status: "waiting", updatedAt: 20 }),
    thread("e", { updatedAt: 10 }),
    thread("C", { parentId: "c", status: "running" }),
    thread("batch", { masterId: "d", status: "running" }),
  ];
  const seen = { a: 40, b: 90, c: 60, d: 20, e: 10 };
  const build = (paneIds: string[], extra: Partial<Parameters<typeof buildHeaderModel>[0]> = {}) =>
    buildHeaderModel({
      threads: roots,
      tabs: [{ id: "tab", sessionIds: paneIds }],
      scope: { project: "p1" },
      activeTabId: "tab",
      lastSeen: seen,
      planReady: {},
      ...extra,
    });

  it("holds every root of the scope: the live row in the saved order, the shelf freshest first", () => {
    const model = orderModel(build([]), ["d", "a"]);
    expect(model.live.map((c) => c.id)).toEqual(["d", "a"]);
    expect(model.dormant.map((c) => c.id)).toEqual(["b", "c", "e"]);
    expect(model.activeId).toBeNull();
  });

  it("highlights a settled thread on screen where it sits on the shelf", () => {
    const model = orderModel(build(["c"]), []);
    expect(model.activeId).toBe("c");
    expect(model.dormant.map((c) => c.id)).toContain("c");
    expect(model.live.map((c) => c.id)).not.toContain("c");
  });

  it("a subagent alone on screen draws its root active, with the subagent's tab", () => {
    const model = orderModel(build(["C"]), []);
    expect(model.activeId).toBe("c");
    expect(model.dormant.find((chip) => chip.id === "c")?.tabId).toBe("tab");
  });

  it("gives a batch child a chip only while it is on screen, never saved", () => {
    const shown = orderModel(build(["batch"]), ["d", "a"]);
    expect(shown.live.map((c) => c.id)).toEqual(["d", "a", "batch"]);
    expect(shown.activeId).toBe("batch");
    expect(saveIds(shown)).toEqual(["d", "a"]);
    const away = orderModel(build(["a"]), ["d", "a"]);
    expect(headerOrder(away).map((c) => c.id)).not.toContain("batch");
  });

  it("a settling chip holds its place on the live row and stays off the shelf", () => {
    const before = orderModel(build([]), ["d", "a"]);
    const settled = orderModel(build([], { threads: roots.map((t) => (t.id === "a" ? { ...t, status: "idle" as const } : t)) }), ["d", "a"]);
    expect(settled.live.map((c) => c.id)).toEqual(["d"]);
    const held = holdModel(settled, before.live.map((c) => c.id), true);
    expect(held.live.map((c) => c.id)).toEqual(["d", "a"]);
    expect(held.dormant.map((c) => c.id)).not.toContain("a");
    expect(holdModel(settled, before.live.map((c) => c.id), false)).toBe(settled);
  });

  it("an archived thread on screen leaves even while holding", () => {
    const model = orderModel(build(["x"], { threads: [thread("x", { archived: true })] }), []);
    expect(holdModel(model, ["x"], true).live).toEqual([]);
  });

  it("the outside chip stays last while a held chip keeps its place", () => {
    const before = orderModel(build(["batch"]), ["d", "a"]);
    const settled = orderModel(
      build(["batch"], { threads: roots.map((t) => (t.id === "a" ? { ...t, status: "idle" as const } : t)) }),
      ["d", "a"],
    );
    expect(holdModel(settled, before.live.map((c) => c.id), true).live.map((c) => c.id)).toEqual(["d", "a", "batch"]);
  });
});

describe("rootOf and tabRoot", () => {
  const tree = [thread("A"), thread("B"), thread("C", { parentId: "A" }), thread("D", { parentId: "C" })];

  it("climbs the parentId chain to the root", () => {
    expect(rootOf(tree, "D")).toBe("A");
    expect(rootOf(tree, "B")).toBe("B");
    expect(rootOf(tree, "unknown")).toBe("unknown");
  });

  it("reads the focused thread pane's root, else the first thread's, else nothing", () => {
    expect(tabRoot(tree, ["C", "B", "A"])).toBe("A");
    expect(tabRoot(tree, ["file:1", "B"])).toBe("B");
    expect(tabRoot(tree, ["file:1"])).toBeNull();
  });
});
