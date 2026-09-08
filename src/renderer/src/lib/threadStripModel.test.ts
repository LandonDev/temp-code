import { describe, expect, it } from "vitest";
import {
  archivedRootThreads,
  chipTone,
  displayStatus,
  isLiveThread,
  projectRootThreads,
  runningRoots,
  splitThreads,
  type StripThread,
} from "./threadStripModel";

const thread = (id: string, extra: Partial<StripThread> = {}): StripThread => ({
  id,
  status: "idle",
  updatedAt: 100,
  projectId: "p1",
  parentId: null,
  archived: false,
  ...extra,
});

describe("projectRootThreads", () => {
  it("keeps only the project's unarchived roots, freshest first", () => {
    const all = [
      thread("old", { updatedAt: 1 }),
      thread("child", { parentId: "old" }),
      thread("gone", { archived: true }),
      thread("other", { projectId: "p2" }),
      thread("loose", { projectId: null }),
      thread("new", { updatedAt: 9 }),
    ];
    expect(projectRootThreads(all, "p1").map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("shows nothing when no project is selected: loose chats stay off the strip", () => {
    expect(projectRootThreads([thread("loose", { projectId: null })], null)).toEqual([]);
  });

  it("lists the archived roots for the shelf", () => {
    const all = [thread("a", { archived: true, updatedAt: 1 }), thread("b", { archived: true, updatedAt: 2 }), thread("c")];
    expect(archivedRootThreads(all, "p1").map((t) => t.id)).toEqual(["b", "a"]);
    expect(archivedRootThreads(all, null)).toEqual([]);
  });
});

describe("isLiveThread", () => {
  const seen = { x: 100 };
  it("keeps working, waiting, failed and paused roots live", () => {
    for (const status of ["running", "starting", "waiting", "error", "paused"] as const)
      expect(isLiveThread(thread("x", { status }), seen, {})).toBe(true);
  });

  it("keeps a settled root live while its tree works, is paused or can continue", () => {
    expect(isLiveThread(thread("x", { treeHasLiveWork: true }), seen, {})).toBe(true);
    expect(isLiveThread(thread("x", { treeHasPaused: true }), seen, {})).toBe(true);
    expect(isLiveThread(thread("x", { treeCanContinue: true }), seen, {})).toBe(true);
  });

  it("keeps unread and plan-ready roots live", () => {
    expect(isLiveThread(thread("x", { updatedAt: 101 }), seen, {})).toBe(true);
    expect(isLiveThread(thread("x"), seen, { x: true })).toBe(true);
  });

  it("sends a settled, seen root to the shelf even when it is blank or selected", () => {
    expect(isLiveThread(thread("x"), seen, {})).toBe(false);
    expect(isLiveThread(thread("x", { status: "done" }), seen, {})).toBe(false);
  });

  it("treats a never-seen root as unread and a draft as always live", () => {
    expect(isLiveThread(thread("y", { updatedAt: 1 }), {}, {})).toBe(true);
    expect(isLiveThread(thread("d", { draft: true }), { d: 100 }, {})).toBe(true);
  });

  it("counts a never-seen root as seen up to the floor", () => {
    expect(isLiveThread(thread("y", { updatedAt: 1 }), {}, {}, 50)).toBe(false);
    expect(isLiveThread(thread("y", { updatedAt: 60 }), {}, {}, 50)).toBe(true);
  });
});

describe("splitThreads", () => {
  it("orders each row freshest first", () => {
    const seen = { a: 10, b: 40, c: 30, d: 20 };
    const { live, dormant } = splitThreads(
      [
        thread("a", { updatedAt: 10, status: "running" }),
        thread("b", { updatedAt: 40 }),
        thread("c", { updatedAt: 30, status: "waiting" }),
        thread("d", { updatedAt: 20 }),
      ],
      seen,
      {},
    );
    expect(live.map((t) => t.id)).toEqual(["c", "a"]);
    expect(dormant.map((t) => t.id)).toEqual(["b", "d"]);
  });
});

describe("displayStatus and chipTone", () => {
  it("lets a paused descendant outrank a recoverable failure outrank the root's status", () => {
    expect(displayStatus(thread("x", { status: "running", treeHasPaused: true }))).toBe("paused");
    expect(displayStatus(thread("x", { status: "idle", treeCanContinue: true }))).toBe("error");
    expect(displayStatus(thread("x", { status: "waiting" }))).toBe("waiting");
  });

  it("washes waiting and paused amber, failed red, unread blue, else nothing", () => {
    expect(chipTone("waiting", false)).toBe("warning");
    expect(chipTone("paused", false)).toBe("warning");
    expect(chipTone("error", true)).toBe("danger");
    expect(chipTone("idle", true)).toBe("info");
    expect(chipTone("done", true)).toBe("info");
    expect(chipTone("idle", false)).toBeNull();
    expect(chipTone("running", true)).toBeNull();
  });
});

describe("runningRoots", () => {
  it("counts unarchived roots with live work anywhere in their tree", () => {
    const all = [
      thread("a", { treeHasLiveWork: true }),
      thread("b", { treeHasLiveWork: true, archived: true }),
      thread("c", { treeHasLiveWork: true, parentId: "a" }),
      thread("d", { status: "running" }),
    ];
    expect(runningRoots(all).map((t) => t.id)).toEqual(["a"]);
  });
});
