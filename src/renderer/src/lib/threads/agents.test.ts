import { describe, expect, it } from "vitest";
import type { Block, Session } from "../session";
import type { SessionMeta } from "../tcserver/types";
import {
  agentRank,
  agentStats,
  agentStatus,
  childrenOf,
  fleetCounts,
  fleetSentence,
  leadStripped,
  loadsTranscript,
  sortAgents,
  taskTitle,
  TONE_CLASS,
} from "./agents";
import { STATUS_WORD, statusToneClass } from "../../components/ui/status";

const block = (role: Block["role"], text: string, extra: Partial<Block> = {}): Block => ({
  id: `${role}:${text}`,
  role,
  text,
  ...extra,
});

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    status: "idle",
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as SessionMeta;

describe("agentRank", () => {
  it("puts waiting first, then failed, then working, then the rest", () => {
    expect(agentRank("waiting")).toBe(0);
    expect(agentRank("error")).toBe(1);
    expect(agentRank("running")).toBe(2);
    expect(agentRank("starting")).toBe(2);
    expect(agentRank("idle")).toBe(3);
    expect(agentRank("paused")).toBe(3);
    expect(agentRank(undefined)).toBe(3);
  });

  it("sorts by rank then age", () => {
    const list = sortAgents([
      meta("b", { status: "running", createdAt: 5 }),
      meta("a", { status: "idle", createdAt: 1 }),
      meta("c", { status: "running", createdAt: 2 }),
      meta("d", { status: "waiting", createdAt: 9 }),
    ]);
    expect(list.map((m) => m.id)).toEqual(["d", "c", "b", "a"]);
  });
});

describe("childrenOf", () => {
  it("keeps unarchived children of the parent only", () => {
    const list = childrenOf(
      [
        meta("p"),
        meta("x", { parentId: "p" }),
        meta("y", { parentId: "p", archived: true }),
        meta("z", { parentId: "q" }),
      ],
      "p",
    );
    expect(list.map((m) => m.id)).toEqual(["x"]);
  });

  it("lists a child spawned on another host under its parent, with its host on the row", () => {
    const box = `env_${"b".repeat(22)}`;
    const list = childrenOf(
      [
        meta("p"),
        meta("here", { parentId: "p", createdAt: 1 }),
        meta("far", { parentId: "p", environmentId: box, status: "running", createdAt: 2 }),
        meta("other", { parentId: "q", environmentId: box }),
      ],
      "p",
    );
    expect(list.map((m) => [m.id, m.environmentId])).toEqual([
      ["far", box],
      ["here", "local"],
    ]);
  });
});

describe("fleetCounts", () => {
  it("buckets by status", () => {
    expect(
      fleetCounts([
        { status: "running" },
        { status: "starting" },
        { status: "waiting" },
        { status: "error" },
        { status: "idle" },
        { status: "paused" },
        { status: "watching" },
      ]),
    ).toEqual({ working: 3, waiting: 1, failed: 1, done: 2 });
  });
});

describe("taskTitle", () => {
  it("is the first user line", () => {
    expect(taskTitle([block("assistant", "hi"), block("user", "Refactor the auth module\nwith care")])).toBe(
      "Refactor the auth module",
    );
    expect(taskTitle([])).toBe("");
  });
});

describe("agentStatus", () => {
  const failure: SessionMeta["failure"] = { kind: "quota", account: null, summary: "usage cap", cause: "" };

  it("a working agent says the host's phrase in place of the word", () => {
    expect(agentStatus({ status: "running", activity: " Editing HomeView.swift " })).toEqual({
      state: "working",
      detail: "Editing HomeView.swift",
      phrase: true,
    });
    expect(agentStatus({ status: "running" })).toEqual({ state: "working", detail: "Thinking", phrase: true });
    expect(agentStatus({ status: "starting", activity: null })).toEqual({ state: "working", detail: "Starting", phrase: true });
  });

  it("watching and queued drop the lead their word already says", () => {
    expect(agentStatus({ status: "watching", activity: "Waiting on bun test" })).toEqual({
      state: "watching",
      detail: "bun test",
      phrase: false,
    });
    expect(agentStatus({ status: "queued", activity: "Queued · 120 of 120 running" })).toEqual({
      state: "queued",
      detail: "120 of 120 running",
      phrase: false,
    });
  });

  it("a waiting agent quotes its question, else the approval it needs", () => {
    const q = block("assistant", "", {
      question: { sessionId: "s", requestId: "r", questions: [{ question: "Which db?\nmore", options: [] }] },
    });
    expect(agentStatus({ status: "waiting" }, [q])).toEqual({ state: "waiting", detail: "Which db?", phrase: false });
    const a = block("approval", "", { approval: { requestId: 1 }, tool: { title: "rm -rf build" } });
    expect(agentStatus({ status: "waiting" }, [a]).detail).toBe("approve rm -rf build");
    const decided = block("approval", "", { approval: { requestId: 1, decided: "allow" }, tool: { title: "ls" } });
    expect(agentStatus({ status: "waiting" }, [decided]).detail).toBe("");
    expect(agentStatus({ status: "waiting" })).toEqual({ state: "waiting", detail: "", phrase: false });
  });

  it("a failed agent says the host's summary over the transcript's error line", () => {
    const err = block("system", "Rate limited\nstack", { id: "err:1" });
    expect(agentStatus({ status: "error", failure }, [err]).detail).toBe("usage cap");
    expect(agentStatus({ status: "error" }, [err])).toEqual({ state: "failed", detail: "Rate limited", phrase: false });
    expect(agentStatus({ status: "error" }).detail).toBe("");
  });

  it("idle and done are done; paused and stopped say only their word", () => {
    expect(agentStatus({ status: "idle", activity: "stale" })).toEqual({ state: "done", detail: "", phrase: false });
    expect(agentStatus({ status: "done" })).toEqual({ state: "done", detail: "", phrase: false });
    expect(agentStatus({ status: "paused" })).toEqual({ state: "paused", detail: "", phrase: false });
    expect(agentStatus({ status: "stopped" })).toEqual({ state: "stopped", detail: "", phrase: false });
  });
});

describe("leadStripped", () => {
  it("takes off only the lead of its own state", () => {
    expect(leadStripped("Waiting on 3 subagents, a monitor", "watching")).toBe("3 subagents, a monitor");
    expect(leadStripped("Queued · waiting for Sibling", "queued")).toBe("waiting for Sibling");
    expect(leadStripped("Waiting on x", "queued")).toBe("Waiting on x");
    expect(leadStripped("Editing a.ts", "working")).toBe("Editing a.ts");
  });
});

describe("the vocabulary is the one map", () => {
  it("counts are said in StatusMark's words and tones, and a line's tone is the state's", () => {
    const parts = fleetSentence({ working: 1, waiting: 1, failed: 1, done: 1 });
    expect(parts.map((p) => p.text)).toEqual(
      (["working", "waiting", "failed", "done"] as const).map((s) => `1 ${STATUS_WORD[s].toLowerCase()}`),
    );
    expect(parts[1].tone).toBe(statusToneClass("waiting"));
    expect(parts[2].tone).toBe(statusToneClass("failed"));
    expect(TONE_CLASS).toEqual({
      warning: statusToneClass("waiting"),
      danger: statusToneClass("failed"),
      muted: statusToneClass("done"),
    });
  });

  it("ranks and counts by threadStateOf: starting works, watching counts as working, the quiet states as done", () => {
    expect(agentRank("starting")).toBe(agentRank("running"));
    expect(agentRank("queued")).toBe(agentRank("idle"));
    expect(
      fleetCounts([{ status: "starting" }, { status: "watching" }, { status: "queued" }, { status: "stopped" }, { status: "paused" }]),
    ).toEqual({ working: 2, waiting: 0, failed: 0, done: 3 });
  });
});

describe("fleetSentence", () => {
  it("says the nonzero counts in order, with the tones that mean something", () => {
    expect(fleetSentence({ working: 2, waiting: 1, failed: 0, done: 3 })).toEqual([
      { text: "2 working", tone: undefined },
      { text: "1 needs you", tone: "text-warning" },
      { text: "3 done", tone: undefined },
    ]);
    expect(fleetSentence({ working: 0, waiting: 0, failed: 1, done: 0 })).toEqual([
      { text: "1 failed", tone: "text-destructive" },
    ]);
    expect(fleetSentence({ working: 0, waiting: 0, failed: 0, done: 0 })).toEqual([]);
  });
});

describe("agentStats", () => {
  it("sums edit previews and reads tasks, context, and cost", () => {
    const session = {
      environmentId: "local",
      blocks: [
        block("tool", "", { tool: { preview: { kind: "write", additions: 10, deletions: 4 } } }),
        block("tool", "", { tool: { preview: { kind: "write", additions: 2 } } }),
        block("tool", "", { tool: { preview: { kind: "read" } } }),
      ],
      tasks: { done: 2, total: 5 },
      context: { used: 50, window: 200 },
      thread: { cost: 1.25 },
    } as unknown as Session;
    expect(agentStats(session)).toEqual({
      adds: 12,
      dels: 4,
      tasksDone: 2,
      tasksTotal: 5,
      ctxPct: 25,
      cost: 1.25,
    });
  });

  it("falls back to the folded todo list and tolerates a missing session", () => {
    const session = {
      environmentId: "local",
      blocks: [],
      thread: { todos: [{ status: "completed" }, { status: "pending" }] },
    } as unknown as Session;
    expect(agentStats(session)).toMatchObject({ tasksDone: 1, tasksTotal: 2, ctxPct: null, cost: undefined });
    expect(agentStats(undefined)).toEqual({
      adds: 0,
      dels: 0,
      tasksDone: 0,
      tasksTotal: 0,
      ctxPct: null,
      cost: undefined,
    });
  });
});

describe("loadsTranscript", () => {
  it("loads only to quote a waiting agent, or a failure the meta lacks", () => {
    expect(loadsTranscript({ status: "waiting" })).toBe(true);
    expect(loadsTranscript({ status: "error" })).toBe(true);
    expect(loadsTranscript({ status: "error", failure: { kind: "unknown", account: null, summary: "x", cause: "" } })).toBe(false);
    for (const status of ["running", "starting", "watching", "done", "idle", "queued", "paused"] as const) {
      expect(loadsTranscript({ status })).toBe(false);
    }
  });
});
