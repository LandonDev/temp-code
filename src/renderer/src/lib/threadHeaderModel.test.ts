import { describe, expect, it } from "vitest";
import {
  buildHeaderModel,
  headerNeighbour,
  headerOrder,
  pauseAllLabel,
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
      selectedProjectId: "p1",
      activeTabId: "t-run",
      lastSeen,
      planReady: {},
    });
    expect(model.live.map((c) => c.id)).toEqual(["unread", "wait", "run"]);
    expect(model.dormant.map((c) => c.id)).toEqual(["seen"]);
    expect(model.live.map((c) => c.tabId)).toEqual([null, null, "t-run"]);
    expect(model.activeId).toBe("run");
  });

  it("wears the tree-aware status and tone", () => {
    const model = buildHeaderModel({
      threads: [thread("x", { status: "running", treeHasPaused: true }), thread("y", { updatedAt: 200 })],
      tabs: [],
      selectedProjectId: "p1",
      activeTabId: null,
      lastSeen: { x: 100, y: 100 },
      planReady: {},
    });
    expect(model.live.map((c) => [c.id, c.status, c.tone, c.unread])).toEqual([
      ["y", "idle", "info", true],
      ["x", "paused", "warning", false],
    ]);
  });

  it("has no chips without a project and no active chip when a file tab is up", () => {
    expect(
      buildHeaderModel({ threads, tabs, selectedProjectId: null, activeTabId: "t-run", lastSeen, planReady: {} }),
    ).toEqual({ live: [], dormant: [], activeId: null });
    const model = buildHeaderModel({
      threads,
      tabs,
      selectedProjectId: "p1",
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
      selectedProjectId: "p1",
      activeTabId: "t-seen",
      lastSeen,
      planReady: {},
    });
    expect(model.dormant.map((c) => c.id)).toEqual(["seen"]);
    expect(model.activeId).toBe("seen");
  });
});

describe("headerOrder and headerNeighbour", () => {
  const model = buildHeaderModel({
    threads,
    tabs,
    selectedProjectId: "p1",
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
      selectedProjectId: "p1",
      activeTabId: null,
      lastSeen: {},
      planReady: {},
    });
    expect(headerNeighbour(lone, "only")).toBeNull();
  });
});

describe("pauseAllLabel", () => {
  it("names each state", () => {
    expect(pauseAllLabel("idle")).toBe("Pause all");
    expect(pauseAllLabel("busy")).toBe("Pausing…");
    expect(pauseAllLabel("failed")).toBe("Pause failed — retry");
  });
});
