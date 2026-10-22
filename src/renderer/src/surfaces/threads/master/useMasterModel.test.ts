import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_RULES } from "@server/shared/contract-batch";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import {
  batchFromPush,
  blockedLine,
  foldRows,
  groupOf,
  groupRows,
  masterChildrenOf,
  masterCounts,
  mergedLine,
  rulesSentence,
  typeWord,
} from "./useMasterModel";

let n = 0;
const meta = (status: SessionStatus, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: `c${++n}`,
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
    expect(rulesSentence(DEFAULT_BATCH_RULES)).toBe("Branches land as they finish, then gate and release. Then you are notified.");
  });
  it("names every step the rules ask for, and none when they ask for nothing", () => {
    const steps = [...DEFAULT_BATCH_RULES.steps, { id: "deploy", name: "Deploy to the box", kind: "deploy" as const }];
    expect(rulesSentence({ land: "all-at-once", steps, then: "archive-children" })).toBe(
      "Branches land together once every thread is done, then gate, release and deploy to the box. Then the threads are archived.",
    );
    expect(rulesSentence({ land: "as-they-finish", steps: [DEFAULT_BATCH_RULES.steps[0]], then: "notify" })).toBe(
      "Branches land as they finish, nothing runs after. Then you are notified.",
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
    expect(batchFromPush({ push: "batch", masterId: "m", steps }, "m")).toBeNull();
    expect(batchFromPush({ push: "batch", state: { masterId: "x", steps } }, "m")).toBeNull();
    expect(batchFromPush({ push: "session" }, "m")).toBeNull();
  });
});
