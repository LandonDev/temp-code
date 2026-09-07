import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../../lib/session";
import {
  fleetActive,
  fleetLine,
  fleetStats,
  isCompacting,
  panelOpen,
  resolveOverride,
  statsParts,
} from "./useFleetModel";

const block = (role: Block["role"], text: string, extra: Partial<Block> = {}): Block => ({
  id: `${role}:${text}`,
  role,
  text,
  ...extra,
});

const session = (extra: Partial<Session> = {}): Session => ({ id: "s", blocks: [], ...extra }) as unknown as Session;

const thread = (extra: Record<string, unknown> = {}) =>
  ({ todos: [], cost: undefined, ...extra }) as unknown as Session["thread"];

describe("panel open state", () => {
  it("opens while a child works or waits, not for failed or done", () => {
    expect(fleetActive({ working: 1, waiting: 0, failed: 0, done: 0 })).toBe(true);
    expect(fleetActive({ working: 0, waiting: 1, failed: 0, done: 0 })).toBe(true);
    expect(fleetActive({ working: 0, waiting: 0, failed: 2, done: 3 })).toBe(false);
  });

  it("a manual toggle wins until the fleet flips", () => {
    expect(panelOpen(null, true)).toBe(true);
    expect(panelOpen(false, true)).toBe(false);
    expect(panelOpen(true, false)).toBe(true);
    expect(resolveOverride(false, true, true)).toBe(false);
    expect(resolveOverride(false, true, false)).toBeNull();
    expect(resolveOverride(true, false, true)).toBeNull();
    expect(panelOpen(resolveOverride(false, true, false), false)).toBe(false);
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

describe("statsParts", () => {
  const base = { adds: 0, dels: 0, tasksDone: 0, tasksTotal: 0, ctxPct: null, cost: undefined, compacting: false };

  it("is empty with nothing to say", () => {
    expect(statsParts(base)).toEqual([]);
  });

  it("shows the task fraction with its percent and the ring", () => {
    expect(statsParts({ ...base, adds: 12, dels: 3, tasksDone: 3, tasksTotal: 7, ctxPct: 42 })).toEqual([
      { key: "diff", adds: 12, dels: 3 },
      { key: "tasks", done: 3, total: 7, pct: 43 },
      { key: "ctx", pct: 42 },
    ]);
  });

  it("replaces the ring with compacting while compaction runs", () => {
    expect(statsParts({ ...base, ctxPct: 90, compacting: true })).toEqual([{ key: "compact" }]);
  });
});

describe("fleetLine", () => {
  it("says compacting only while live", () => {
    const s = session({
      thread: thread({ compacting: true }),
      blocks: [block("assistant", "done here")],
    });
    expect(fleetLine("running", s).text).toBe("compacting the context…");
    expect(fleetLine("idle", s).text).toBe("done here");
  });

  it("falls through to the agent line otherwise", () => {
    const s = session({
      blocks: [block("tool", "", { tool: { name: "Bash", input: { command: "ls" } } as Block["tool"] })],
    });
    expect(fleetLine("running", s).text).toContain("ls");
    expect(fleetLine("waiting", s)).toEqual({ text: "waiting for approval", tone: "warning" });
  });
});
