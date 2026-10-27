import { describe, expect, it } from "vitest";
import type { Session } from "../../../lib/session";
import { agentNumbers, fleetActive, fleetStats, isCompacting } from "./useFleetModel";

const session = (extra: Partial<Session> = {}): Session => ({ id: "s", blocks: [], ...extra }) as unknown as Session;

const thread = (extra: Record<string, unknown> = {}) =>
  ({ todos: [], cost: undefined, ...extra }) as unknown as Session["thread"];

describe("fleetActive", () => {
  it("a child working or waiting, not failed or done", () => {
    expect(fleetActive({ working: 1, waiting: 0, failed: 0, done: 0 })).toBe(true);
    expect(fleetActive({ working: 0, waiting: 1, failed: 0, done: 0 })).toBe(true);
    expect(fleetActive({ working: 0, waiting: 0, failed: 2, done: 3 })).toBe(false);
  });
});

describe("fleetStats", () => {
  it("prefers the polled reading's window over the harness level", () => {
    const s = session({ context: { used: 50, window: 100 } });
    expect(fleetStats(s, null).ctxPct).toBe(50);
    expect(fleetStats(s, { totalTokens: 80, maxTokens: 100, percentage: 80 }).ctxPct).toBe(80);
    expect(fleetStats(s, { totalTokens: 80, maxTokens: 0, percentage: 0 }).ctxPct).toBe(50);
  });

  it("reads M4's compacting flag and tolerates its absence", () => {
    expect(isCompacting(session({ thread: thread({ compacting: true }) }))).toBe(true);
    expect(isCompacting(session({ thread: thread() }))).toBe(false);
    expect(isCompacting(undefined)).toBe(false);
  });
});

describe("agentNumbers", () => {
  const base = { adds: 0, dels: 0, tasksDone: 0, tasksTotal: 0, ctxPct: null, cost: undefined, compacting: false };

  it("is empty with nothing to say", () => {
    expect(agentNumbers(base, undefined, null)).toEqual([]);
    expect(agentNumbers(base, 0, 0)).toEqual([]);
  });

  it("gives every part in order: diff, tasks, context, cost, elapsed", () => {
    expect(agentNumbers({ ...base, adds: 140, dels: 12, tasksDone: 3, tasksTotal: 7, ctxPct: 42 }, 0.123, 252_000)).toEqual([
      { key: "diff", adds: 140, dels: 12 },
      { key: "tasks", text: "3/7 tasks" },
      { key: "context", text: "42% context" },
      { key: "cost", text: "$0.12" },
      { key: "elapsed", text: "4m 12s" },
    ]);
  });

  it("says Compacting over the context while compaction runs", () => {
    expect(agentNumbers({ ...base, ctxPct: 90, compacting: true }, undefined, null)).toEqual([
      { key: "context", text: "Compacting" },
    ]);
  });
});
