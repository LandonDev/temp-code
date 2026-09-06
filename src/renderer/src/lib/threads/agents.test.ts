import { describe, expect, it } from "vitest";
import type { Block, Session } from "../session";
import type { SessionMeta } from "../tcserver/types";
import {
  activityLine,
  agentLine,
  agentRank,
  agentStats,
  childrenOf,
  fleetCounts,
  lastAssistantLine,
  sortAgents,
  taskTitle,
} from "./agents";

const block = (role: Block["role"], text: string, extra: Partial<Block> = {}): Block => ({
  id: `${role}:${text}`,
  role,
  text,
  ...extra,
});

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
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
      ]),
    ).toEqual({ working: 2, waiting: 1, failed: 1, done: 2 });
  });
});

describe("transcript lines", () => {
  const blocks: Block[] = [
    block("user", "Refactor the auth module\nwith care"),
    block("assistant", "Sure, starting now.\nMore detail."),
    block("tool", "", { tool: { name: "Bash", input: { command: "npm test\n--watch" } } }),
    block("reasoning", "hmm"),
  ];

  it("activityLine names the latest tool and its detail", () => {
    expect(activityLine(blocks)).toBe("Bash · npm test");
    expect(activityLine(blocks.slice(0, 2))).toBe("Sure, starting now.");
    expect(activityLine([...blocks, block("system", "boom", { id: "err:9" })])).toBe("boom");
    expect(activityLine([])).toBe("");
  });

  it("prefers the tool's own detail over its input", () => {
    expect(
      activityLine([block("tool", "", { tool: { name: "Read", detail: "src/a.ts", input: { file_path: "x" } } })]),
    ).toBe("Read · src/a.ts");
  });

  it("lastAssistantLine skips tools and reasoning", () => {
    expect(lastAssistantLine(blocks)).toBe("Sure, starting now.");
    expect(lastAssistantLine([block("assistant", "  ")])).toBe("");
  });

  it("taskTitle is the first user line", () => {
    expect(taskTitle(blocks)).toBe("Refactor the auth module");
    expect(taskTitle([])).toBe("");
  });
});

describe("agentLine", () => {
  it("shows the question while waiting", () => {
    const q = block("assistant", "", {
      question: {
        sessionId: "s",
        requestId: "r",
        questions: [{ question: "Which db?\nmore", options: [] }],
      },
    });
    expect(agentLine("waiting", [q])).toEqual({ text: "has a question — Which db?", tone: "warning" });
  });

  it("shows the pending approval while waiting", () => {
    const a = block("approval", "", { approval: { requestId: 1 }, tool: { title: "rm -rf build" } });
    expect(agentLine("waiting", [a])).toEqual({ text: "waiting for approval — rm -rf build", tone: "warning" });
    expect(agentLine("waiting", [])).toEqual({ text: "waiting for approval", tone: "warning" });
  });

  it("shows the error, activity, or last words by status", () => {
    const err = block("system", "Rate limited", { id: "err:1" });
    expect(agentLine("error", [err])).toEqual({ text: "Rate limited", tone: "danger" });
    expect(agentLine("error", [])).toEqual({ text: "failed", tone: "danger" });
    const tool = block("tool", "", { tool: { name: "Grep", input: { pattern: "foo" } } });
    expect(agentLine("running", [block("assistant", "hi"), tool])).toEqual({ text: "Grep · foo", tone: "muted" });
    expect(agentLine("idle", [block("assistant", "Done."), tool])).toEqual({ text: "Done.", tone: "muted" });
  });
});

describe("agentStats", () => {
  it("sums edit previews and reads tasks, context, and cost", () => {
    const session = {
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
