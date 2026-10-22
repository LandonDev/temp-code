import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_RULES, DEFAULT_BATCH_STEPS } from "@server/shared/contract-batch";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import {
  batchChildrenOf,
  batchFromPush,
  blockedLine,
  foldRows,
  groupOf,
  groupRows,
  masterChildrenOf,
  masterCounts,
  mergeBatchChildren,
  mergedLine,
  rowHost,
  rulesSentence,
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
    expect(groupOf("waiting")).toBe("needsYou");
    expect(groupOf("error")).toBe("needsYou");
    expect(groupOf("starting")).toBe("running");
    expect(groupOf("running")).toBe("running");
    expect(groupOf("watching")).toBe("running");
    expect(groupOf("paused")).toBe("running");
    expect(groupOf("queued")).toBe("queued");
    expect(groupOf("idle")).toBe("done");
    expect(groupOf("stopped")).toBe("done");
  });

  it("returns the non-empty sections in order", () => {
    const rows = [meta("idle"), meta("running"), meta("waiting")].map(rowOf);
    const groups = groupRows(rows);
    expect(groups.map((g) => g.id)).toEqual(["needsYou", "running", "done"]);
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Running", "Done"]);
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
  it("names another host with the chip's dot tone, and offline while its link is not open", () => {
    const away = meta("idle", { environmentId: "box" });
    expect(rowHost(away, master, envs, () => ({ transport: "open", fresh: true }))).toEqual({ id: "box", name: "The box", tone: "bg-success", offline: false });
    expect(rowHost(away, master, envs, () => ({ transport: "offline", fresh: false }))).toEqual({ id: "box", name: "The box", tone: "bg-content/25", offline: true });
    expect(rowHost(away, master, envs, () => ({ transport: "reconnecting", fresh: false }))).toMatchObject({ tone: "bg-warning", offline: true });
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

  it("never folds against a plan outside the batch", () => {
    const foreign = meta("idle", { threadType: "planning", masterId: "other", title: "Elsewhere" });
    const build = meta("running", { title: "Build", planThreadId: foreign.id });
    const rows = foldRows([build], [foreign, build], "m");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: build.id, plan: null, title: "Build" });
  });
});

describe("the rules sentence", () => {
  it("reads the defaults as one sentence", () => {
    expect(rulesSentence({ ...DEFAULT_BATCH_RULES, steps: DEFAULT_BATCH_STEPS })).toBe(
      "Branches land as they finish, then Gate and Release. Then you are notified.",
    );
  });
  it("names every step the master wrote in its words, and none when the list is the merge alone", () => {
    expect(
      rulesSentence({
        land: "all-at-once",
        then: "archive-children",
        steps: [
          { id: "land", name: "Merging", kind: "land" },
          { id: "build", name: "Build the plugin", kind: "shell", run: "gradle build" },
          { id: "deploy", name: "Deploy to dev", kind: "shell", run: "./deploy" },
          { id: "smoke", name: "Smoke test", kind: "shell", run: "./smoke" },
        ],
      }),
    ).toBe("Branches land together once every thread is done, then Build the plugin, Deploy to dev and Smoke test. Then the threads are archived.");
    expect(rulesSentence({ land: "as-they-finish", then: "notify", steps: [{ id: "land", name: "Merging", kind: "land" }] })).toBe(
      "Branches land as they finish, nothing runs after. Then you are notified.",
    );
    expect(rulesSentence({ land: "as-they-finish", then: "notify", steps: [{ id: "gate", name: "Gate", kind: "gate" }] })).toBe(
      "The branches are left unmerged, then Gate. Then you are notified.",
    );
  });
  it("names the blocking child", () => {
    const titleOf = (id: string) => (id === "c9" ? "Inbox" : undefined);
    expect(blockedLine({ blocked: { sessionId: "c9", why: "errored" } }, titleOf)).toBe("Blocked: Inbox errored");
    expect(blockedLine({ blocked: { sessionId: "zz", why: "stopped" } }, titleOf)).toBe("Blocked: a thread stopped");
    expect(blockedLine({ blocked: null }, titleOf)).toBeNull();
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
    const children = [{ sessionId: "a", environmentId: "box", status: "running" }];
    expect(batchChildrenOf(batchFromPush({ push: "batch", state: { masterId: "m", steps, children } }, "m"))).toEqual(children);
    expect(batchFromPush({ push: "batch", masterId: "m", steps }, "m")).toBeNull();
    expect(batchFromPush({ push: "batch", state: { masterId: "x", steps } }, "m")).toBeNull();
    expect(batchFromPush({ push: "session" }, "m")).toBeNull();
  });
});
