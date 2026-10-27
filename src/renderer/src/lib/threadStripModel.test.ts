import type { BackgroundWork } from "@shared/events";
import { describe, expect, it } from "vitest";
import {
  archivedRootThreads,
  hasPendingQuestion,
  lowerFirst,
  marksAtRest,
  threadStatus,
  dormantByType,
  dormantThreads,
  focusedTree,
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

  it("keeps a master's batch children off the strip: they live on the board", () => {
    const all = [
      thread("master", { updatedAt: 5 }),
      thread("child", { masterId: "master", updatedAt: 9 }),
      thread("gone-child", { masterId: "master", archived: true }),
      thread("plain", { updatedAt: 1 }),
    ];
    expect(projectRootThreads(all, "p1").map((t) => t.id)).toEqual(["master", "plain"]);
    expect(archivedRootThreads(all, "p1").map((t) => t.id)).toEqual([]);
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
  it("keeps working, waiting, failed, paused and watching roots live", () => {
    for (const status of ["running", "starting", "waiting", "error", "paused", "watching"] as const)
      expect(isLiveThread(thread("x", { status }), seen, {})).toBe(true);
  });

  it("keeps a plan-ready root live whether it settled idle or on a background wait", () => {
    expect(isLiveThread(thread("x"), seen, { x: true })).toBe(true);
    expect(isLiveThread(thread("x", { status: "watching" }), seen, { x: true })).toBe(true);
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

describe("threadStatus", () => {
  const bg = (over: Partial<BackgroundWork> = {}): BackgroundWork => ({ tasks: [], agents: [], ...over }) as BackgroundWork;

  it("reads a paused descendant as paused, outranking everything", () => {
    expect(threadStatus({ status: "running", treeHasPaused: true, treeCanContinue: true, activity: "Running bun" })).toEqual({
      state: "paused",
      detail: null,
      tally: null,
    });
  });

  it("reads a recoverable failure in the tree as failed with the host's summary", () => {
    expect(threadStatus({ status: "idle", treeCanContinue: true, failure: "Usage cap." })).toEqual({
      state: "failed",
      detail: "usage cap",
      tally: null,
    });
  });

  it("says what a working thread does, with its round's tally", () => {
    expect(threadStatus({ status: "running", activity: "Running bun", tasks: { done: 3, total: 7 } })).toEqual({
      state: "working",
      detail: "running bun",
      tally: "3/7",
    });
    expect(threadStatus({ status: "running" })).toEqual({ state: "working", detail: null, tally: null });
  });

  it("says starting for a starting thread with no activity yet", () => {
    expect(threadStatus({ status: "starting" })).toEqual({ state: "working", detail: "starting", tally: null });
    expect(threadStatus({ status: "starting", activity: "Booting claude" }).detail).toBe("booting claude");
  });

  it("names the approval a waiting thread needs, else its question, else nothing", () => {
    expect(threadStatus({ status: "waiting", waitingOn: "Bash: bun test", asking: true })).toEqual({
      state: "waiting",
      detail: "approve Bash: bun test",
      tally: null,
    });
    expect(threadStatus({ status: "waiting", asking: true }).detail).toBe("answer a question");
    expect(threadStatus({ status: "waiting" })).toEqual({ state: "waiting", detail: null, tally: null });
  });

  it("is plan-ready on idle and on watching, never on running", () => {
    expect(threadStatus({ status: "idle", planReady: true })).toEqual({ state: "plan-ready", detail: null, tally: null });
    expect(threadStatus({ status: "watching", planReady: true, background: bg({ agents: ["a"] }) }).state).toBe("plan-ready");
    expect(threadStatus({ status: "running", planReady: true }).state).toBe("working");
  });

  it("says what a watching thread watches: the background, else the host's line, else background work", () => {
    expect(threadStatus({ status: "watching", background: bg({ agents: ["a", "b", "c"] }) }).detail).toBe("3 subagents");
    expect(threadStatus({ status: "watching", activity: "Waiting on 2 monitors" }).detail).toBe("2 monitors");
    expect(threadStatus({ status: "watching" })).toEqual({ state: "watching", detail: "background work", tally: null });
    const lone = bg({ tasks: [{ id: "t", label: "Sleep 45 seconds in the background", kind: "shell", startedAt: 0 }] });
    expect(threadStatus({ status: "watching", background: lone }).detail).toBe("sleep 45 seconds in the background");
  });

  it("gives a queued thread the host's reason past the word", () => {
    expect(threadStatus({ status: "queued", activity: "Queued · 120 of 120 running" }).detail).toBe("120 of 120 running");
    expect(threadStatus({ status: "queued", activity: "Queued · waiting for Plan A19" }).detail).toBe("waiting for Plan A19");
    expect(threadStatus({ status: "queued" })).toEqual({ state: "queued", detail: null, tally: null });
  });

  it("says the harness is gone for a stopped thread", () => {
    expect(threadStatus({ status: "stopped" })).toEqual({ state: "stopped", detail: "the harness is gone", tally: null });
  });

  it("gives an errored thread its summary, or nothing", () => {
    expect(threadStatus({ status: "error", failure: "Rate limited by the provider" }).detail).toBe("rate limited by the provider");
    expect(threadStatus({ status: "error" })).toEqual({ state: "failed", detail: null, tally: null });
  });

  it("says nothing more for paused, idle and done", () => {
    for (const status of ["paused", "idle", "done"] as const)
      expect(threadStatus({ status, activity: "Running bun", tasks: { done: 1, total: 2 } })).toEqual({
        state: status,
        detail: null,
        tally: null,
      });
  });
});

describe("lowerFirst, marksAtRest and hasPendingQuestion", () => {
  it("lower-cases the first letter, keeps an acronym, drops the full stop", () => {
    expect(lowerFirst("Usage cap.")).toBe("usage cap");
    expect(lowerFirst("PR checks failed")).toBe("PR checks failed");
    expect(lowerFirst("  ")).toBeNull();
    expect(lowerFirst(null)).toBeNull();
  });

  it("marks every state at rest but idle and done", () => {
    expect(marksAtRest("idle")).toBe(false);
    expect(marksAtRest("done")).toBe(false);
    for (const state of ["working", "waiting", "paused", "failed", "queued", "stopped", "watching", "plan-ready"] as const)
      expect(marksAtRest(state)).toBe(true);
  });

  it("finds an undecided question, not an answered or dismissed one", () => {
    expect(hasPendingQuestion([{ question: { answers: undefined } }])).toBe(true);
    expect(hasPendingQuestion([{ question: { answers: [["Yes"]] } }, { question: { answers: null } }, {}])).toBe(false);
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

describe("dormantThreads", () => {
  it("takes only settled, seen, unpinned roots with nothing live in the tree", () => {
    const seen = { seen: 100, pinned: 100, plan: 100, "seen-done": 100 };
    const all = [
      thread("seen"),
      thread("seen-done", { status: "done" }),
      thread("unread"),
      thread("working", { status: "running" }),
      thread("starting", { status: "starting" }),
      thread("needs-you", { status: "waiting" }),
      thread("paused-kid", { treeHasPaused: true }),
      thread("busy-kid", { treeHasLiveWork: true }),
      thread("failed-kid", { treeCanContinue: true }),
      thread("draft", { draft: true }),
      { ...thread("pinned"), pinned: true },
      { ...thread("plan"), threadType: "planning" as const, planPath: "/p/plan.md" },
    ];
    expect(dormantThreads(all, seen).map((t) => t.id)).toEqual(["seen", "seen-done"]);
  });

  it("counts a thread with no seen entry as seen up to the floor", () => {
    expect(dormantThreads([thread("old", { updatedAt: 50 }), thread("new")], {}, 60)).toEqual([
      thread("old", { updatedAt: 50 }),
    ]);
  });

  it("spares every id in the exclude set", () => {
    const seen = { a: 100, b: 100 };
    const all = [thread("a"), thread("b")];
    expect(dormantThreads(all, seen, 0, new Set(["a"])).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("dormantByType", () => {
  it("slices by type in chooser order with singular and plural nouns", () => {
    const groups = dormantByType([
      { ...thread("r"), threadType: "research" as const },
      { ...thread("c1"), threadType: "chat" as const },
      { ...thread("c2"), threadType: "chat" as const },
      { ...thread("i"), threadType: "implementation" as const },
      thread("untyped"),
    ]);
    expect(groups.map((g) => [g.type, g.label, g.threads.map((t) => t.id)])).toEqual([
      ["chat", "Archive 3 dormant chats", ["c1", "c2", "untyped"]],
      ["implementation", "Archive 1 dormant implementation thread", ["i"]],
      ["research", "Archive 1 dormant research thread", ["r"]],
    ]);
  });

  it("offers nothing when one type covers every dormant thread", () => {
    expect(dormantByType([thread("a"), thread("b")])).toEqual([]);
    expect(dormantByType([])).toEqual([]);
  });
});

describe("focusedTree", () => {
  const metas = [
    thread("root"),
    thread("kid", { parentId: "root" }),
    thread("grandkid", { parentId: "kid" }),
    thread("other"),
    thread("other-kid", { parentId: "other" }),
  ];

  it("is the focused session's root and every descendant", () => {
    expect([...focusedTree(metas, "kid")].sort()).toEqual(["grandkid", "kid", "root"]);
    expect([...focusedTree(metas, "root")].sort()).toEqual(["grandkid", "kid", "root"]);
  });

  it("is empty with no focus and just the id for an unknown session", () => {
    expect(focusedTree(metas, null).size).toBe(0);
    expect([...focusedTree(metas, "gone")]).toEqual(["gone"]);
  });
});
