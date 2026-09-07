import { describe, expect, it } from "vitest";
import {
  cardTasks,
  cardTooltip,
  pausedElapsed,
  projectCardStatus,
  projectRunAction,
  quietSummary,
  runningElapsed,
  stoppableThreads,
  type CardThread,
} from "./projectCardModel";

const thread = (id: string, extra: Partial<CardThread> = {}): CardThread => ({
  id,
  title: id,
  status: "idle",
  updatedAt: 100,
  threadType: "chat",
  busySince: null,
  frozenActiveElapsed: null,
  ...extra,
});

const ids = (list: CardThread[]) => list.map((t) => t.id);

describe("projectCardStatus", () => {
  it("puts each thread in one bucket, loudest first", () => {
    const status = projectCardStatus(
      [
        thread("run", { status: "running" }),
        thread("tree-run", { status: "idle", treeHasLiveWork: true }),
        thread("paused", { status: "paused" }),
        thread("tree-paused", { status: "running", treeHasPaused: true }),
        thread("wait", { status: "waiting" }),
        thread("fail", { status: "error" }),
        thread("tree-fail", { status: "idle", treeCanContinue: true }),
        thread("unread", { status: "done", updatedAt: 200 }),
        thread("seen", { status: "idle" }),
      ],
      null,
      { unread: 150, seen: 100 },
    );
    expect(ids(status.paused)).toEqual(["paused", "tree-paused"]);
    expect(ids(status.running)).toEqual(["run", "tree-run"]);
    expect(status.waiting).toBe(1);
    expect(status.failed).toBe(2);
    expect(ids(status.unread)).toEqual(["unread"]);
    expect(status.dormant).toBe(1);
    expect(status.total).toBe(9);
    expect(status.latest).toBe(200);
  });

  it("lets live work outrank a failure the tree moved past", () => {
    const status = projectCardStatus(
      [thread("x", { status: "error", treeHasLiveWork: true })],
      null,
      {},
    );
    expect(ids(status.running)).toEqual(["x"]);
    expect(status.failed).toBe(0);
  });

  it("never counts the open thread or a recoverable one as unread", () => {
    const status = projectCardStatus(
      [
        thread("open", { updatedAt: 200 }),
        thread("recover", { updatedAt: 200, treeCanContinue: true }),
      ],
      "open",
      {},
    );
    expect(status.unread).toEqual([]);
    expect(status.failed).toBe(1);
    expect(status.dormant).toBe(1);
  });

  it("is empty for a project with no threads", () => {
    const status = projectCardStatus([], null, {});
    expect(status).toMatchObject({ total: 0, dormant: 0, latest: 0, waiting: 0, failed: 0 });
  });
});

describe("copy", () => {
  const status = projectCardStatus(
    [
      thread("a", { status: "running" }),
      thread("b", { status: "paused" }),
      thread("c", { status: "waiting" }),
      thread("d", { status: "error" }),
      thread("e", { updatedAt: 200 }),
      thread("f"),
    ],
    null,
    { e: 1, f: 100 },
  );

  it("joins every non-zero state and the tab count for the tooltip", () => {
    expect(cardTooltip(status, 2)).toBe(
      "1 running · 1 paused · 1 waiting on you · 1 failed · 1 unread · 6 open tabs · 2 archived",
    );
    expect(cardTooltip(projectCardStatus([thread("a")], null, { a: 100 }), 0)).toBe("1 open tab");
  });

  it("summarises the quiet rest", () => {
    expect(quietSummary(status, 2)).toBe("1 dormant · 2 archived");
    expect(quietSummary(status, 0)).toBe("1 dormant");
    expect(quietSummary(projectCardStatus([], null, {}), 3)).toBe("No tabs");
  });
});

describe("lines", () => {
  it("measures a running line from its working stretch, never negative", () => {
    expect(runningElapsed(thread("a", { busySince: 40 }), 100)).toBe(60);
    expect(runningElapsed(thread("a", { updatedAt: 90 }), 100)).toBe(10);
    expect(runningElapsed(thread("a", { busySince: 500 }), 100)).toBe(0);
  });

  it("freezes a paused line at the pause, tree-wide when known", () => {
    expect(pausedElapsed(thread("a", { frozenActiveElapsed: 5, treeFrozenActiveElapsed: 9 }))).toBe(9);
    expect(pausedElapsed(thread("a", { frozenActiveElapsed: 5 }))).toBe(5);
    expect(pausedElapsed(thread("a"))).toBe(0);
  });

  it("shows a tally only for implementation threads", () => {
    const tasks = { done: 1, total: 3, current: "Wire it" };
    expect(cardTasks(thread("a", { threadType: "implementation", tasks }))).toEqual(tasks);
    expect(cardTasks(thread("a", { threadType: "implementation" }))).toBeNull();
    expect(cardTasks(thread("a", { threadType: "planning", tasks }))).toBeNull();
  });
});

describe("menu", () => {
  it("offers continue when anything is paused, else pause when anything runs", () => {
    const both = projectCardStatus(
      [thread("r", { status: "running" }), thread("p", { status: "paused" })],
      null,
      {},
    );
    expect(projectRunAction(both)).toBe("resume");
    expect(projectRunAction(projectCardStatus([thread("r", { status: "running" })], null, {}))).toBe("pause");
    expect(projectRunAction(projectCardStatus([thread("i")], null, {}))).toBeNull();
    expect(ids(stoppableThreads(both))).toEqual(["r", "p"]);
  });
});
