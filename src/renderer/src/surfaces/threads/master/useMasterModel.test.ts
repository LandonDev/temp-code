import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_RULES, DEFAULT_BATCH_STEPS, emptyBatch, type BatchState } from "@server/shared/contract-batch";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { marksAtRest } from "../../../lib/threadStripModel";
import { rowState } from "../../../lib/sidebarRows";
import {
  batchChildrenOf,
  batchFromPush,
  blockedLine,
  boardLayout,
  boardShown,
  BoardDigests,
  doneTally,
  foldBatchPush,
  foldRows,
  GROUP_LABEL,
  GROUP_ORDER,
  groupOf,
  groupRows,
  masterChildrenOf,
  masterCounts,
  mergeBatchChildren,
  standInMeta,
  mergedLine,
  rowHost,
  typeWord,
} from "./useMasterModel";

let n = 0;
const meta = (status: SessionStatus, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: `c${++n}`,
    environmentId: "local",
    parentId: null,
    masterId: "m",
    archived: false,
    status,
    createdAt: n,
    updatedAt: n,
    cwd: "/repo",
    threadType: "implementation",
    title: `Thread ${n}`,
    ...extra,
  }) as unknown as SessionMeta;

const rowOf = (m: SessionMeta) => ({ key: m.id, meta: m, plan: null, title: m.title });

describe("grouping by status", () => {
  it("files every status into one of the four sections", () => {
    expect(groupOf({ status: "waiting" })).toBe("needsYou");
    expect(groupOf({ status: "error" })).toBe("needsYou");
    expect(groupOf({ status: "starting" })).toBe("running");
    expect(groupOf({ status: "running" })).toBe("running");
    expect(groupOf({ status: "watching" })).toBe("running");
    expect(groupOf({ status: "paused" })).toBe("running");
    expect(groupOf({ status: "queued" })).toBe("queued");
    expect(groupOf({ status: "idle" })).toBe("done");
    expect(groupOf({ status: "stopped" })).toBe("done");
  });

  it("files a settled thread whose subagents still work with the running ones, as the host's done rule leaves it out", () => {
    const watching = { tasks: [], agents: ["a1"], batch: null, watchingSince: 1 } as unknown as SessionMeta["background"];
    expect(groupOf({ status: "idle", background: watching })).toBe("running");
    expect(groupOf({ status: "done", background: watching })).toBe("running");
    expect(groupOf({ status: "idle", background: { ...watching!, agents: [] } })).toBe("done");
    expect(groupOf({ status: "stopped", background: watching })).toBe("done");
    expect(masterCounts([{ meta: { status: "idle", background: watching } }, { meta: { status: "idle" } }])).toEqual({ needsYou: 0, running: 1, queued: 0, done: 1 });
  });

  it("returns the non-empty sections in order", () => {
    const rows = [meta("idle"), meta("running"), meta("waiting")].map(rowOf);
    const groups = groupRows(rows);
    expect(groups.map((g) => g.id)).toEqual(["needsYou", "running", "done"]);
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Working", "Done"]);
    expect(masterCounts(rows)).toEqual({ needsYou: 1, running: 1, queued: 0, done: 1 });
  });

  it("filters the master's unarchived roots and nothing else", () => {
    const mine = meta("running");
    const all = [
      mine,
      meta("running", { masterId: "other" }),
      meta("running", { parentId: "x" }),
      meta("idle", { archived: true }),
      meta("idle", { masterId: null as unknown as string }),
    ];
    expect(masterChildrenOf(all, "m")).toEqual([mine]);
  });

  it("takes the children of every host as one list, oldest first", () => {
    const home = meta("running");
    const away = meta("idle", { environmentId: "box" });
    const other = meta("queued", { environmentId: "studio" });
    expect(masterChildrenOf([other, away, home], "m")).toEqual([home, away, other]);
    expect(masterCounts([home, away, other].map(rowOf))).toEqual({ needsYou: 0, running: 1, queued: 1, done: 1 });
  });
});

describe("a row's host", () => {
  const envs = [
    { id: "local", name: "This Mac" },
    { id: "box", name: "The box" },
  ];
  const master = { environmentId: "local" };
  it("is nothing for a thread on the master's host", () => {
    expect(rowHost(meta("idle"), master, envs, () => ({ transport: "open", fresh: true }))).toBeNull();
  });
  it("names another host, and offline while its link is not open", () => {
    const away = meta("idle", { environmentId: "box" });
    expect(rowHost(away, master, envs, () => ({ transport: "open", fresh: true }))).toEqual({ id: "box", name: "The box", offline: false });
    expect(rowHost(away, master, envs, () => ({ transport: "offline", fresh: false }))).toEqual({ id: "box", name: "The box", offline: true });
    expect(rowHost(away, master, envs, () => ({ transport: "reconnecting", fresh: false }))).toMatchObject({ offline: true });
    expect(rowHost(away, master, envs, () => undefined)).toMatchObject({ offline: true });
    expect(rowHost(meta("idle", { environmentId: "studio" }), master, envs, () => undefined)?.name).toBe("studio");
  });
});

describe("the batch's own child list", () => {
  it("reads children by shape and nothing else", () => {
    expect(batchChildrenOf(null)).toEqual([]);
    expect(batchChildrenOf({ children: "no" })).toEqual([]);
    expect(
      batchChildrenOf({
        children: [
          { sessionId: "a", environmentId: "box", title: "Home", status: "running", type: "implementation", extra: 1 },
          { sessionId: "b", environmentId: "local" },
          { sessionId: 3, environmentId: "box" },
          null,
        ],
      }),
    ).toEqual([
      { sessionId: "a", environmentId: "box", title: "Home", status: "running", threadType: "implementation" },
      { sessionId: "b", environmentId: "local" },
    ]);
  });

  it("lays the list over the rows: its host and status win, the bodies stay, an unknown child becomes a plain row, no list changes nothing", () => {
    const home = meta("running", { title: "Home" });
    const moved = meta("idle", { title: "Search", environmentId: "local" });
    const rows = [home, moved].map(rowOf);
    expect(mergeBatchChildren(rows, [], "m")).toBe(rows);
    const same = mergeBatchChildren(rows, [{ sessionId: home.id, environmentId: "local", status: "running" }], "m");
    expect(same).toBe(rows);
    const merged = mergeBatchChildren(
      rows,
      [
        { sessionId: moved.id, environmentId: "box", status: "waiting" },
        { sessionId: "ghost", environmentId: "studio", title: "Inbox", status: "queued", threadType: "research" },
      ],
      "m",
    );
    expect(merged[0]).toBe(rows[0]);
    expect(merged[1].meta).toMatchObject({ id: moved.id, environmentId: "box", status: "waiting", title: "Search" });
    expect(merged[1].title).toBe("Search");
    expect(merged[2]).toMatchObject({ key: "ghost", title: "Inbox", plan: null });
    expect(merged[2].meta).toMatchObject({ id: "ghost", environmentId: "studio", status: "queued", threadType: "research", masterId: "m", parentId: null });
    expect(groupRows(merged).map((g) => [g.id, g.rows.length])).toEqual([
      ["needsYou", 1],
      ["running", 1],
      ["queued", 1],
    ]);
  });

  it("a stand-in for a child the store lacks is a whole meta: the list's provider, model and effort, the rest at rest, never cast", () => {
    const listed = batchChildrenOf({
      children: [{ sessionId: "far", environmentId: "box", title: "Far", status: "running", threadType: "implementation", provider: "codex", model: "gpt-6.1-sol", reasoning: "high" }],
    });
    expect(listed[0]).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", reasoning: "high" });
    const [row] = mergeBatchChildren([], listed, "m");
    expect(row.meta).toMatchObject({ id: "far", masterId: "m", provider: "codex", model: "gpt-6.1-sol", reasoning: "high", context1m: false, archived: false, cwd: "" });
    for (const key of ["provider", "model", "reasoning", "agentType", "permission", "projectId", "workspaceId", "planPath", "nativeId", "busySince"]) expect(key in row.meta).toBe(true);
    // A list from a host that names no provider or model (an older host, or '' for a child not yet described): no model, so no mark.
    expect(standInMeta({ sessionId: "x", environmentId: "box" }, "m")).toMatchObject({ provider: "claude", model: "", reasoning: "medium", status: "idle", title: "" });
    expect(standInMeta({ sessionId: "x", environmentId: "box", provider: "", model: "m1", reasoning: "warp" }, "m")).toMatchObject({ model: "", reasoning: "medium" });
    expect(standInMeta({ sessionId: "x", environmentId: "box", provider: "martian", model: "m1" }, "m").model).toBe("");
  });

  it("never doubles a plan the build's row already stands for", () => {
    const plan = meta("idle", { threadType: "planning", title: "Search screen" });
    const build = meta("running", { planThreadId: plan.id });
    const rows = foldRows([plan, build], [plan, build], "m");
    const merged = mergeBatchChildren(rows, [{ sessionId: plan.id, environmentId: "local" }], "m");
    expect(merged).toHaveLength(1);
  });
});

describe("a plan and its build are one row", () => {
  it("gives the build the plan's row: its key, its title, the plan beside it", () => {
    const plan = meta("idle", { threadType: "planning", title: "Search screen", archived: true, implementationId: "build" });
    const build = meta("running", { id: "build", title: "Search: the results screen", planThreadId: plan.id });
    const other = meta("queued", { title: "Inbox" });
    const metas = [plan, build, other];
    const rows = foldRows(masterChildrenOf(metas, "m"), metas, "m");
    expect(rows.map((r) => r.key)).toEqual([plan.id, other.id]);
    expect(rows[0]).toMatchObject({ meta: build, plan, title: "Search screen" });
    expect(typeWord(rows[0].meta)).toBe("Implementation");
  });

  it("draws a plan still unarchived once as its build's row, and a plan without a build as itself", () => {
    const plan = meta("idle", { threadType: "planning", title: "Search screen" });
    const build = meta("running", { planThreadId: plan.id });
    const lone = meta("running", { threadType: "planning", title: "Settings" });
    const metas = [plan, build, lone];
    const rows = foldRows(masterChildrenOf(metas, "m"), metas, "m");
    expect(rows.map((r) => r.title)).toEqual(["Search screen", "Settings"]);
    expect(rows[1].plan).toBeNull();
  });

  it("a plan that started several builds: the first takes the plan's row, each later build is a row of its own, every key once", () => {
    const plan = meta("idle", { threadType: "planning", title: "Bots", implementationId: "b3" });
    const b1 = meta("idle", { id: "b1", title: "Bots: first pass", planThreadId: plan.id });
    const b2 = meta("idle", { id: "b2", title: "Bots: second pass", planThreadId: plan.id });
    const b3 = meta("running", { id: "b3", title: "Bots: third pass", planThreadId: plan.id });
    const metas = [plan, b1, b2, b3];
    const rows = foldRows(masterChildrenOf(metas, "m"), metas, "m");
    expect(rows.map((r) => r.key)).toEqual([plan.id, "b2", "b3"]);
    expect(rows.map((r) => r.title)).toEqual(["Bots", "Bots: second pass", "Bots: third pass"]);
    expect(rows.map((r) => r.plan?.id ?? null)).toEqual([plan.id, null, null]);
  });

  it("the layout of a plan with several builds is the same object when read again: the board's snapshot settles", () => {
    const plans = [0, 1, 2].map((i) => meta("idle", { threadType: "planning", title: `Plan ${i}` }));
    const builds = [3, 2, 1].flatMap((count, i) =>
      Array.from({ length: count }, (_, j) => meta(j === count - 1 ? "running" : "idle", { title: `Build ${i}.${j}`, planThreadId: plans[i]!.id })),
    );
    const metas = [...plans, ...builds];
    const of = (id: string) => metas.find((m) => m.id === id) ?? null;
    const first = boardLayout("m", metas, of, [], []);
    expect(new Set(first.rows.map((r) => r.key)).size).toBe(first.rows.length);
    expect(first.rows).toHaveLength(6);
    expect(boardLayout("m", metas, of, [], [], first)).toBe(first);
  });

  it("never folds against a plan outside the batch", () => {
    const foreign = meta("idle", { threadType: "planning", masterId: "other", title: "Elsewhere" });
    const build = meta("running", { title: "Build", planThreadId: foreign.id });
    const rows = foldRows([build], [foreign, build], "m");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: build.id, plan: null, title: "Build" });
  });
});

describe("the batch's words", () => {
  it("names the blocking child", () => {
    const titleOf = (id: string) => (id === "c9" ? "Inbox" : undefined);
    expect(blockedLine({ blocked: { sessionId: "c9", why: "errored" } }, titleOf)).toBe("Blocked: Inbox errored");
    expect(blockedLine({ blocked: { sessionId: "zz", why: "stopped" } }, titleOf)).toBe("Blocked: a thread stopped");
    expect(blockedLine({ blocked: null }, titleOf)).toBeNull();
    expect(blockedLine({ blocked: { sessionId: "c9", why: "no-turn" } }, titleOf)).toBe(
      "Blocked: Inbox ended its turn without completing",
    );
    expect(
      blockedLine({ blocked: { sessionId: "c9", why: "unreachable", environmentId: "env_box" } }, titleOf, (id) =>
        id === "env_box" ? "box" : undefined,
      ),
    ).toBe("Blocked: Inbox is out of reach on box");
    // A far child is blocked by its `<env>:<session>` id: the batch's list names it.
    expect(
      blockedLine(
        {
          blocked: { sessionId: "env_box:s7", why: "errored" },
          children: [{ sessionId: "s7", environmentId: "env_box", title: "Pricing survey", status: "error", threadType: null, provider: "", model: "" }],
        },
        titleOf,
      ),
    ).toBe("Blocked: Pricing survey errored");
  });
});

describe("the batch", () => {
  it("reads 'n of m merged' from landed and pending", () => {
    expect(mergedLine({ landed: ["a", "b"], pending: Array.from({ length: 8 }, (_, i) => `p${i}`) })).toBe("2 of 10 landed");
  });
  it("takes a batch push for this master, with its rules, and ignores anything else", () => {
    const steps = [{ id: "land", status: "running", detail: "1 of 3", at: 1 }];
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps, landed: ["a"], pending: [] } }, "m")).toEqual({
      masterId: "m",
      rules: DEFAULT_BATCH_RULES,
      steps,
      landed: ["a"],
      pending: [],
      held: [],
      blocked: null,
      finishedAt: null,
    });
    const rules = { ...DEFAULT_BATCH_RULES, deploy: "box", summary: "Land all seven" };
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps, rules } }, "m")?.rules).toEqual(rules);
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps } }, "m")?.landed).toEqual([]);
    // The host's done list survives a push, an empty one too, so Archive done keeps the host's count.
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps, done: ["a", "box:f"] } }, "m")?.done).toEqual(["a", "box:f"]);
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps, done: [] } }, "m")?.done).toEqual([]);
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps } }, "m")).not.toHaveProperty("done");
    const children = [{ sessionId: "a", environmentId: "box", status: "running" }];
    expect(batchChildrenOf(batchFromPush({ push: "batch", state: { masterId: "m", steps, children } }, "m"))).toEqual(children);
    expect(batchFromPush({ push: "batch", masterId: "m", steps }, "m")).toBeNull();
    expect(batchFromPush({ push: "batch", state: { masterId: "x", steps } }, "m")).toBeNull();
    expect(batchFromPush({ push: "session" }, "m")).toBeNull();
  });
});

describe("the sections", () => {
  it("say the vocabulary's words: Needs you, Working, Queued, Done", () => {
    expect(GROUP_ORDER.map((id) => GROUP_LABEL[id])).toEqual(["Needs you", "Working", "Queued", "Done"]);
  });
});

describe("the digests", () => {
  it("prunes departed children and their signatures using whole-board membership", () => {
    const store = new BoardDigests();
    store.replace({ a: { last: "Local" }, b: { last: "Far" } });
    const b = store.get("b");
    store.replace({ a: { last: "Local again" } });
    expect(store.get("b")).toBe(b);
    let told = 0;
    store.subscribe(() => told++);
    store.retain(new Set(["b"]));
    expect(store.get("a")).toEqual({});
    expect(store.get("b")).toBe(b);
    expect(told).toBe(1);
    store.retain(new Set(["b"]));
    expect(told).toBe(1);
    store.set("a", { last: "Local again" });
    expect(store.get("a")).toEqual({ last: "Local again" });
    expect(told).toBe(2);
  });

  it("keep a digest's object while it reads the same, and tell subscribers only when one changed", () => {
    const store = new BoardDigests();
    let told = 0;
    store.subscribe(() => told++);
    store.replace({ a: { last: "One" }, b: { todos: [{ content: "x", status: "pending" }] } });
    expect(told).toBe(1);
    const a = store.get("a");
    store.replace({ a: { last: "One" }, b: { todos: [{ content: "x", status: "pending" }] } });
    expect(told).toBe(1);
    expect(store.get("a")).toBe(a);
    store.set("b", { todos: [{ content: "x", status: "completed" }] });
    expect(told).toBe(2);
    expect(store.get("a")).toBe(a);
    expect(store.get("zz")).toEqual({});
  });
});

describe("the batch push's log deltas", () => {
  const state = (steps: unknown[]): BatchState => ({ ...emptyBatch("m"), steps: steps as BatchState["steps"] });
  const gate = (extra: Record<string, unknown>) => ({ id: "gate", name: "Gate", kind: "gate", status: "running", detail: "", at: 1, startedAt: 100, ...extra });

  it("appends the lines after what is held and drops an overlap", () => {
    const held = state([gate({ log: ["a", "b"], logCount: 2 })]);
    const next = foldBatchPush(held, state([gate({ log: { from: 2, lines: ["c", "d"] } })]));
    expect(next.gap).toBe(false);
    expect(next.state.steps[0].log).toEqual(["a", "b", "c", "d"]);
    expect(next.state.steps[0].logCount).toBe(4);
    const overlap = foldBatchPush(next.state, state([gate({ log: { from: 3, lines: ["d", "e"] } })]));
    expect(overlap.state.steps[0].log).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("starts a step that ran again from its first line, and calls a push past what is held a gap", () => {
    const held = state([gate({ log: ["a", "b"], logCount: 2 })]);
    const again = foldBatchPush(held, state([gate({ startedAt: 200, log: { from: 0, lines: ["fresh"] } })]));
    expect(again.state.steps[0].log).toEqual(["fresh"]);
    const missed = foldBatchPush(held, state([gate({ log: { from: 5, lines: ["f"] } })]));
    expect(missed.gap).toBe(true);
    expect(missed.state.steps[0].log).toEqual(["a", "b"]);
    const missedRestart = foldBatchPush(held, state([gate({ startedAt: 200, log: { from: 3, lines: ["x"] } })]));
    expect(missedRestart.gap).toBe(true);
  });

  it("keeps the newest 200 lines, and takes a whole log from an older host as it is", () => {
    const held = state([gate({ log: Array.from({ length: 200 }, (_, i) => `l${i}`), logCount: 200 })]);
    const next = foldBatchPush(held, state([gate({ log: { from: 200, lines: ["l200"] } })]));
    expect(next.state.steps[0].log).toHaveLength(200);
    expect(next.state.steps[0].log[0]).toBe("l1");
    const whole = foldBatchPush(held, state([gate({ log: ["only"] })]));
    expect(whole.state.steps[0].log).toEqual(["only"]);
  });
});

describe("the board's layout", () => {
  const child = (id: string, status: SessionStatus, extra: Partial<SessionMeta> = {}) => meta(status, { id, ...extra });
  const of = (metas: SessionMeta[]) => {
    const byId = new Map(metas.map((m) => [m.id, m]));
    return (id: string) => byId.get(id) ?? null;
  };

  it("tallies the settled rows over all of them, as the rail card's master line does", () => {
    const rows = [
      child("t1", "idle", { createdAt: 1 }),
      child("t2", "done", { createdAt: 2 }),
      child("t3", "stopped", { createdAt: 3 }),
      child("t4", "running", { createdAt: 4 }),
      child("t5", "queued", { createdAt: 5 }),
      child("t6", "error", { createdAt: 6 }),
      child("t7", "idle", { createdAt: 7, background: { tasks: [], agents: ["a"], batch: null, watchingSince: null } }),
    ];
    const layout = boardLayout("m", rows, of(rows), [], []);
    expect(doneTally(layout)).toBe("2/7");
    // The rail's rule (WorkspaceSessions `batchTally`): settled is a row whose mark rests.
    expect(rows.filter((r) => !marksAtRest(rowState(r))).length).toBe(2);
    expect(doneTally(boardLayout("m", [], of([]), [], []))).toBeNull();
  });

  it("is the same object while only what a row shows changed, and new when a row changes section", () => {
    const a = child("la", "running", { createdAt: 1 });
    const b = child("lb", "running", { createdAt: 2 });
    const first = boardLayout("m", [a, b], of([a, b]), [], []);
    expect(first.groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([["running", ["la", "lb"]]]);
    const busier = { ...a, activity: "Running tests" } as SessionMeta;
    expect(boardLayout("m", [busier, b], of([busier, b]), [], [], first)).toBe(first);
    const waiting = { ...a, status: "waiting" } as SessionMeta;
    const moved = boardLayout("m", [waiting, b], of([waiting, b]), [], [], first);
    expect(moved).not.toBe(first);
    expect(moved.groups.map((g) => g.id)).toEqual(["needsYou", "running"]);
    // The untouched row keeps its ref, so its memoized row skips the render.
    expect(moved.rows.find((r) => r.id === "lb")).toBe(first.rows.find((r) => r.id === "lb"));
    expect(moved.counts).toEqual({ needsYou: 1, running: 1, queued: 0, done: 0 });
  });

  it("lets the store's live meta speak for a child it follows from a host in reach, and the list for one out of reach", () => {
    const a = child("le", "waiting", { createdAt: 1 });
    const listed = [{ sessionId: "le", environmentId: "local", status: "running" as SessionStatus }];
    const inReach = boardLayout("m", [a], of([a]), [], listed, undefined, () => true);
    expect(inReach.rows[0]).toMatchObject({ group: "needsYou", override: null });
    const outOfReach = boardLayout("m", [a], of([a]), [], listed, undefined, () => false);
    expect(outOfReach.rows[0]).toMatchObject({ group: "running", override: { environmentId: "local", status: "running" } });
  });

  it("takes a child the answer names and the store does not hold as a row of its own, and the batch's word on a host", () => {
    const a = child("lc", "running", { createdAt: 1 });
    const answered = child("ld", "queued", { createdAt: 2 });
    const layout = boardLayout("m", [a], of([a]), [answered], [{ sessionId: "lc", environmentId: "box", status: "waiting" }]);
    expect(layout.rows.map((r) => [r.id, r.group, r.environmentId])).toEqual([
      ["lc", "needsYou", "box"],
      ["ld", "queued", "local"],
    ]);
    expect(layout.rows[0].override).toEqual({ environmentId: "box", status: "waiting" });
    expect(layout.rows[1].fallback).toBe(answered);
  });
});

describe("boardShown", () => {
  const steps = (...statuses: string[]): BatchState["steps"] =>
    statuses.map((status, i) => ({ id: `s${i}`, name: `Step ${i}`, kind: "shell", status, detail: "", at: 0 })) as unknown as BatchState["steps"];
  const of = (metas: SessionMeta[]) => (id: string) => metas.find((m) => m.id === id) ?? null;

  it("is off with no rows and no running step", () => {
    expect(boardShown({ rows: [] }, { steps: steps() })).toBe(false);
    expect(boardShown({ rows: [] }, emptyBatch("m"))).toBe(false);
  });

  it("is on with one row", () => {
    const a = meta("running");
    expect(boardShown(boardLayout("m", [a], of([a]), [], []), emptyBatch("m"))).toBe(true);
  });

  it("is on with no rows while a step runs", () => {
    expect(boardShown({ rows: [] }, { steps: steps("passed", "running", "pending") })).toBe(true);
  });

  it("is off with no rows once every step settled", () => {
    expect(boardShown({ rows: [] }, { steps: steps("passed", "failed", "skipped") })).toBe(false);
  });
});
