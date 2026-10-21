import { DEFAULT_BATCH_RULES } from "@server/shared/contract-batch";
import { describe, expect, it } from "vitest";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import {
  batchFromPush,
  branchOf,
  countsSentence,
  groupChildren,
  groupOf,
  masterChildrenOf,
  masterCounts,
  mergedLine,
  queuedHint,
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
    ...extra,
  }) as unknown as SessionMeta;

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

  it("returns the non-empty sections in order, rows oldest first", () => {
    const groups = groupChildren([
      meta("idle", { createdAt: 9 }),
      meta("running", { createdAt: 5 }),
      meta("running", { createdAt: 2 }),
      meta("waiting", { createdAt: 7 }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["needsYou", "running", "done"]);
    expect(groups[1].rows.map((r) => r.createdAt)).toEqual([2, 5]);
    expect(groups.find((g) => g.id === "queued")).toBeUndefined();
  });

  it("filters the master's unarchived roots and nothing else", () => {
    const rows = masterChildrenOf(
      [
        meta("running"),
        meta("running", { masterId: "other" }),
        meta("running", { archived: true }),
        meta("running", { parentId: "p" }),
        meta("idle", { masterId: null as unknown as string }),
      ],
      "m",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the counts sentence", () => {
  it("names only the non-zero parts, running first", () => {
    const counts = masterCounts([
      meta("running"),
      meta("running"),
      meta("waiting"),
      meta("queued"),
      meta("queued"),
      meta("queued"),
      meta("idle"),
    ]);
    expect(countsSentence(counts)).toBe("2 running · 1 needs you · 3 queued · 1 done");
  });
  it("is empty with no children, and pluralises needs you", () => {
    expect(countsSentence(masterCounts([]))).toBe("");
    expect(countsSentence(masterCounts([meta("waiting"), meta("error")]))).toBe("2 need you");
  });
});

describe("row words", () => {
  it("hints the Queued label only for a row waiting on the cap", () => {
    expect(queuedHint([meta("queued", { after: "c1" })])).toBeNull();
    expect(queuedHint([meta("queued", { after: null }), meta("queued", { after: "c1" })])).toBe("starts as a slot frees");
  });
  it("names the type in one word and the branch off the worktree", () => {
    expect(typeWord({ threadType: "implementation" })).toBe("impl");
    expect(typeWord({ threadType: "project-plan" })).toBe("project plan");
    expect(typeWord({ threadType: null })).toBe("");
    expect(branchOf({ cwd: "/repo/.claude/worktrees/ios-home" }, "/repo")).toBe("ios-home");
    expect(branchOf({ cwd: "/repo/" }, "/repo")).toBeNull();
  });
});

describe("the batch", () => {
  it("reads 'n of m merged' from landed and pending", () => {
    expect(mergedLine({ landed: ["a", "b"], pending: Array.from({ length: 8 }, (_, i) => `p${i}`) })).toBe("2 of 10 merged");
  });
  it("takes a batch push for this master and ignores anything else", () => {
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
    expect(batchFromPush({ push: "batch", state: { masterId: "m", steps } }, "m")?.landed).toEqual([]);
    expect(batchFromPush({ push: "batch", masterId: "m", steps }, "m")).toBeNull();
    expect(batchFromPush({ push: "batch", state: { masterId: "x", steps } }, "m")).toBeNull();
    expect(batchFromPush({ push: "session" }, "m")).toBeNull();
  });
});
