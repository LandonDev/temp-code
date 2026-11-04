import { describe, expect, it } from "vitest";
import type { Block, Session } from "../session";
import type { SessionMeta } from "../tcserver/types";
import {
  agentRank,
  agentSections,
  agentTime,
  agentTree,
  MAX_AGENT_DEPTH,
  agentStats,
  agentStatus,
  childrenOf,
  fleetCounts,
  fleetSentence,
  leadStripped,
  loadsTranscript,
  modelLabel,
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
    ).toEqual({ working: 2, watching: 1, waiting: 1, failed: 1, done: 2 });
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
      detail: "Bun test",
      phrase: false,
    });
    expect(agentStatus({ status: "queued", activity: "Queued · 120 of 120 running" })).toEqual({
      state: "queued",
      detail: "120 of 120 running",
      phrase: false,
    });
  });

  it("a detail keeps the host's capital; an old host's lower-case lead is read with one", () => {
    expect(agentStatus({ status: "watching", activity: "Waiting on Sleep 90 seconds in the alpha workspace" }).detail).toBe(
      "Sleep 90 seconds in the alpha workspace",
    );
    expect(agentStatus({ status: "watching", activity: "Waiting on README check" }).detail).toBe("README check");
    expect(agentStatus({ status: "queued", activity: "Queued · Waiting for Sibling" }).detail).toBe("Waiting for Sibling");
    const capped: SessionMeta["failure"] = { kind: "quota", account: null, summary: "Usage cap", cause: "" };
    expect(agentStatus({ status: "error", failure: capped }).detail).toBe("Usage cap");
    expect(agentStatus({ status: "watching", activity: "Waiting on sleep 45 seconds", statusDetail: "sleep 45 seconds" }).detail).toBe("sleep 45 seconds");
    expect(agentStatus({ status: "running", activity: "Thinking", statusDetail: "Waiting for the provider, 25 s" }).detail).toBe("Waiting for the provider, 25 s");
    expect(agentStatus({ status: "running", activity: "Editing HomeView.swift" }).detail).toBe("Editing HomeView.swift");
  });

  it("a waiting agent quotes its question, else the approval it needs", () => {
    const q = block("assistant", "", {
      question: { sessionId: "s", requestId: "r", questions: [{ question: "Which db?\nmore", options: [] }] },
    });
    expect(agentStatus({ status: "waiting" }, [q])).toEqual({ state: "waiting", detail: "Which db?", phrase: false });
    const a = block("approval", "", { approval: { requestId: 1 }, tool: { title: "rm -rf build" } });
    expect(agentStatus({ status: "waiting" }, [a]).detail).toBe("Approve rm -rf build");
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
    expect(leadStripped("Queued · waiting for Sibling", "queued")).toBe("Waiting for Sibling");
    expect(leadStripped("Waiting on x", "queued")).toBe("Waiting on x");
    expect(leadStripped("Queued  waiting for Sibling", "queued", "Waiting for Sibling")).toBe("Waiting for Sibling");
    expect(leadStripped("Editing a.ts", "working")).toBe("Editing a.ts");
  });
});

describe("the vocabulary is the one map", () => {
  it("counts are said in StatusMark's words and tones, and a line's tone is the state's", () => {
    const parts = fleetSentence({ working: 1, watching: 1, waiting: 1, failed: 1, done: 1 });
    expect(parts.map((p) => p.text)).toEqual(
      (["working", "watching", "waiting", "failed", "done"] as const).map((s) => `1 ${STATUS_WORD[s].toLowerCase()}`),
    );
    expect(parts[2].tone).toBe(statusToneClass("waiting"));
    expect(parts[3].tone).toBe(statusToneClass("failed"));
    expect(TONE_CLASS).toEqual({
      warning: statusToneClass("waiting"),
      danger: statusToneClass("failed"),
      muted: statusToneClass("done"),
    });
  });

  it("ranks and counts by threadStateOf: starting works, watching counts on its own, the quiet states as done", () => {
    expect(agentRank("starting")).toBe(agentRank("running"));
    expect(agentRank("queued")).toBe(agentRank("idle"));
    expect(
      fleetCounts([{ status: "starting" }, { status: "watching" }, { status: "queued" }, { status: "stopped" }, { status: "paused" }]),
    ).toEqual({ working: 1, watching: 1, waiting: 0, failed: 0, done: 3 });
  });
});

describe("fleetSentence", () => {
  it("says the nonzero counts in order, with the tones that mean something", () => {
    expect(fleetSentence({ working: 2, watching: 0, waiting: 1, failed: 0, done: 3 })).toEqual([
      { text: "2 working", tone: undefined },
      { text: "1 needs you", tone: "text-warning" },
      { text: "3 done", tone: undefined },
    ]);
    expect(fleetSentence({ working: 0, watching: 1, waiting: 0, failed: 0, done: 1 })).toEqual([
      { text: "1 watching", tone: undefined },
      { text: "1 done", tone: undefined },
    ]);
    expect(fleetSentence({ working: 0, watching: 0, waiting: 0, failed: 1, done: 0 })).toEqual([
      { text: "1 failed", tone: "text-destructive" },
    ]);
    expect(fleetSentence({ working: 0, watching: 0, waiting: 0, failed: 0, done: 0 })).toEqual([]);
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

it("the queued lead parses the host's two spaces as it parses the old dot", () => {
  expect(agentStatus({ status: "queued", activity: "Queued  120 of 120 running" }).detail).toBe("120 of 120 running");
  expect(agentStatus({ status: "queued", activity: "Queued  waiting for Sibling" }).detail).toBe("Waiting for Sibling");
  expect(leadStripped("Queued  waiting for Sibling", "queued")).toBe("Waiting for Sibling");
  expect(leadStripped("Queued · waiting for Sibling", "queued")).toBe("Waiting for Sibling");
  expect(leadStripped("Waiting on 3 subagents", "watching")).toBe("3 subagents");
  expect(leadStripped("Thinking", "queued")).toBe("Thinking");
});

it("modelLabel names the catalog's model, the native id when the catalog lacks it, and nothing without a model or a provider", () => {
  expect(modelLabel("claude", "claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(modelLabel("codex", "gpt-nope")).toBe("gpt-nope");
  expect(modelLabel(undefined, undefined)).toBe("");
  expect(modelLabel("claude", undefined)).toBe("");
  expect(modelLabel("", "claude-opus-5-5")).toBe("");
  expect(modelLabel(null, "")).toBe("");
});

describe("agentTree", () => {
  const ids = (rows: { meta: SessionMeta }[]) => rows.map((r) => r.meta.id);

  it("lists the direct children ranked, oldest first within a rank, archived out", () => {
    const metas = [
      meta("done-old", { parentId: "root", createdAt: 1 }),
      meta("working", { parentId: "root", status: "running", createdAt: 5 }),
      meta("waiting", { parentId: "root", status: "waiting", createdAt: 9 }),
      meta("done-new", { parentId: "root", createdAt: 3 }),
      meta("gone", { parentId: "root", archived: true }),
      meta("elsewhere", { parentId: "other" }),
    ];
    expect(ids(agentTree(metas, "root"))).toEqual(["waiting", "working", "done-old", "done-new"]);
  });

  it("puts each top agent's descendants under it in pre-order with their depth", () => {
    const metas = [
      meta("a", { parentId: "root", createdAt: 1 }),
      meta("b", { parentId: "root", createdAt: 2 }),
      meta("a1", { parentId: "a", createdAt: 3 }),
      meta("a1x", { parentId: "a1", createdAt: 4 }),
      meta("a2", { parentId: "a", createdAt: 5 }),
      meta("a2gone", { parentId: "a", archived: true }),
    ];
    const tree = agentTree(metas, "root");
    expect(ids(tree)).toEqual(["a", "b"]);
    expect(tree[0].descendants.map((d) => [d.meta.id, d.depth])).toEqual([
      ["a1", 1],
      ["a1x", 2],
      ["a2", 1],
    ]);
    expect(tree[1].descendants).toEqual([]);
  });

  it("draws a deep chain at most MAX_AGENT_DEPTH in", () => {
    const metas = [meta("t", { parentId: "root" })];
    for (let i = 1; i <= 5; i++) metas.push(meta(`d${i}`, { parentId: i === 1 ? "t" : `d${i - 1}` }));
    const depths = agentTree(metas, "root")[0].descendants.map((d) => d.depth);
    expect(depths).toEqual([1, 2, 3, 3, 3]);
    expect(Math.max(...depths)).toBe(MAX_AGENT_DEPTH);
  });

  it("lifts a top agent whose subtree waits on the person ahead of its peers", () => {
    const metas = [
      meta("w1", { parentId: "root", status: "running", createdAt: 1 }),
      meta("w2", { parentId: "root", status: "running", createdAt: 2 }),
      meta("w2child", { parentId: "w2" }),
      meta("w2grand", { parentId: "w2child", status: "waiting" }),
    ];
    expect(ids(agentTree(metas, "root"))).toEqual(["w2", "w1"]);
  });

  it("survives a parent loop", () => {
    const metas = [meta("a", { parentId: "root" }), meta("b", { parentId: "a" }), meta("a2", { parentId: "b" })];
    const looped = [...metas, { ...metas[0], id: "a", parentId: "b" } as SessionMeta];
    expect(() => agentTree(looped, "root")).not.toThrow();
  });
});

describe("agentSections", () => {
  it("sections the top agents by their own state in the board's order", () => {
    const metas = [
      meta("done", { parentId: "root" }),
      meta("queued", { parentId: "root", status: "queued" }),
      meta("failed", { parentId: "root", status: "error" }),
      meta("paused", { parentId: "root", status: "paused" }),
      meta("working", { parentId: "root", status: "running" }),
      meta("child", { parentId: "done", status: "running" }),
    ];
    const sections = agentSections(agentTree(metas, "root"));
    expect(sections.map((s) => [s.label, s.nodes.map((n) => n.meta.id)])).toEqual([
      ["Needs you", ["failed"]],
      ["Working", ["working", "paused"]],
      ["Queued", ["queued"]],
      ["Done", ["done"]],
    ]);
    // A running grandchild travels with its done top agent.
    expect(sections[3].nodes[0].descendants.map((d) => d.meta.id)).toEqual(["child"]);
  });

  it("returns no empty section", () => {
    expect(agentSections(agentTree([meta("a", { parentId: "root" })], "root")).map((s) => s.id)).toEqual(["done"]);
    expect(agentSections([])).toEqual([]);
  });
});

describe("agentTime", () => {
  const NOW = 1_000_000;
  const timed = (extra: Partial<SessionMeta>) => meta("t", { busySince: null, frozenActiveElapsed: null, ...extra });

  it("ticks a working or waiting agent from its turn's start", () => {
    expect(agentTime(timed({ status: "running", busySince: NOW - 151_000 }), NOW)).toEqual({ ms: 151_000, live: true });
    expect(agentTime(timed({ status: "waiting", busySince: NOW - 5_000 }), NOW)).toEqual({ ms: 5_000, live: true });
    expect(agentTime(timed({ status: "starting", busySince: null }), NOW)).toBeNull();
  });

  it("ticks a watching agent from when it began to watch, else its turn", () => {
    const background = { tasks: [], agents: ["x"], watchingSince: NOW - 60_000 } as unknown as SessionMeta["background"];
    expect(agentTime(timed({ status: "watching", background, busySince: NOW - 90_000 }), NOW)).toEqual({ ms: 60_000, live: true });
    expect(agentTime(timed({ status: "watching", busySince: NOW - 90_000 }), NOW)).toEqual({ ms: 90_000, live: true });
  });

  it("holds a paused agent's frozen time still", () => {
    expect(agentTime(timed({ status: "paused", frozenActiveElapsed: 42_000 }), NOW)).toEqual({ ms: 42_000, live: false });
    expect(agentTime(timed({ status: "paused" }), NOW)).toBeNull();
  });

  it("says nothing for a queued agent", () => {
    expect(agentTime(timed({ status: "queued", busySince: NOW - 9_000, createdAt: 1 }), NOW)).toBeNull();
  });

  it("gives a settled agent how long it ran, spawn to last event, with its finish", () => {
    for (const status of ["idle", "done", "stopped", "error"] as const) {
      expect(agentTime(timed({ status, createdAt: 10_000, lastEventAt: 262_000, updatedAt: 999_999 }), NOW)).toEqual({
        ms: 252_000,
        live: false,
        finishedAt: 262_000,
      });
    }
    expect(agentTime(timed({ status: "idle", createdAt: 10_000, lastEventAt: null, updatedAt: 70_000 }), NOW)?.ms).toBe(60_000);
  });

  it("says nothing under a second or without its stamps", () => {
    expect(agentTime(timed({ status: "idle", createdAt: 10_000, updatedAt: 10_400 }), NOW)).toBeNull();
    expect(agentTime(timed({ status: "running", busySince: NOW - 300 }), NOW)).toBeNull();
    expect(agentTime(timed({ status: "running", busySince: NOW + 5_000 }), 0)).toBeNull();
    expect(agentTime(timed({ status: "idle", createdAt: 0, updatedAt: 0 }), NOW)).toBeNull();
  });
});
