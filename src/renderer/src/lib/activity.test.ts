import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MacBridgeRequest } from "@server/shared/contract-macbridge";
import type { BackgroundWork } from "@server/shared/events";
import { STALE_WATCH_MS } from "@server/shared/watch";
import type { LiveServer } from "./devServers";

const { stopTask, killBackground, stopLiveServer, stopMacBridgeAll } = vi.hoisted(() => ({
  stopTask: vi.fn(() => Promise.resolve()),
  killBackground: vi.fn(() => Promise.resolve()),
  stopLiveServer: vi.fn(() => Promise.resolve()),
  stopMacBridgeAll: vi.fn(() => Promise.resolve()),
}));
vi.mock("./tcserver/commands", () => ({ stopTask, killBackground }));
vi.mock("./devServers", () => ({ stopLiveServer, useLiveDevServers: () => [] }));
vi.mock("./macBridge", () => ({ stopMacBridgeAll, useMacBridgeRunning: () => [] }));
vi.mock("./tcserver/store", () => ({ useSessionMeta: () => null, useSessionMetas: () => [] }));

const { activityRows, hasActivity, rowStale, stopActivity, stopAll, threadServers } = await import("./activity");

const bg = (over: Partial<BackgroundWork>): BackgroundWork => ({ tasks: [], agents: [], batch: null, watchingSince: null, ...over });
const server: LiveServer = {
  key: "env/r1",
  environmentId: "env",
  title: "bun run dev",
  thread: "t",
  port: { number: 5173, environmentId: "env", forwards: undefined },
  runId: null,
  resource: { id: "r1", sessionId: "s1" },
  startedAt: 300,
};
const mac = (status: MacBridgeRequest["status"]): MacBridgeRequest =>
  ({ id: `m-${status}`, environmentId: "box", hostName: "box", sessionId: "s1", threadTitle: "t", kind: "run", method: "mac.run", command: "xcodebuild test", createdAt: 400, expiresAt: 0, status }) as MacBridgeRequest;

beforeEach(() => vi.clearAllMocks());

describe("activityRows", () => {
  it("puts subagents and the batch first, then every source oldest first", () => {
    const rows = activityRows({
      meta: {
        id: "s1",
        status: "watching",
        background: bg({
          tasks: [
            { id: "t2", label: "tail the log", kind: "monitor", startedAt: 200 },
            { id: "t1", label: "Serve the app", kind: "shell", startedAt: 100, command: "bun run dev", callId: "c1" },
            { id: "cron:0", label: "scheduled wake-up (*/5 * * * *)", kind: "cron", startedAt: 50 },
          ],
          agents: ["a1", "a2", "a3"],
          batch: { out: 4, total: 7 },
          watchingSince: 10,
        }),
      },
      agents: [{ busySince: 30, createdAt: 1 }, { busySince: null, createdAt: 20 }],
      devServers: [server],
      macCalls: [mac("running"), mac("held")],
    });
    expect(rows.map((r) => [r.kind, r.label, r.since])).toEqual([
      ["subagents", "3 subagents", 20],
      ["batch", "4 of 7 batch threads", 10],
      ["cron", "Scheduled wake-up (*/5 * * * *)", 50],
      ["shell", "Serve the app", 100],
      ["monitor", "tail the log", 200],
      ["dev", "Dev server :5173", 300],
      ["mac", "xcodebuild test", 400],
    ]);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind.shell).toMatchObject({ detail: "bun run dev", open: "log", taskId: "t1", stop: { type: "task", sessionId: "s1", taskId: "t1" } });
    expect(byKind.cron.stop).toBeUndefined();
    expect(byKind.cron.open).toBeUndefined();
    expect(byKind.subagents).toMatchObject({ open: "agents" });
    expect(byKind.subagents.stop).toBeUndefined();
    expect(byKind.batch.stop).toBeUndefined();
    expect(byKind.dev).toMatchObject({ open: "dev", devKey: "env/r1", stop: { type: "dev" } });
    expect(byKind.monitor.detail).toBeUndefined();
    // A monitor has no output file to tail, so it opens nothing.
    expect(byKind.monitor.open).toBeUndefined();
  });

  it("shows a guarded shell's command as written: the host's marks never reach the row", () => {
    const wrapped = (command: string) => `export TEMP_CODE_THREAD='s1' TEMP_CODE_CALL='toolu_1'; ${command}`;
    const rows = activityRows({
      meta: {
        id: "s1",
        status: "running",
        background: bg({
          tasks: [
            { id: "t1", label: "Serve the app", kind: "shell", startedAt: 100, command: wrapped("bun run dev"), callId: "c1" },
            { id: "t2", label: "sleep 45", kind: "shell", startedAt: 200, command: wrapped("sleep 45"), callId: "c2" },
          ],
        }),
      },
      agents: [],
      devServers: [],
      macCalls: [],
    });
    expect(rows.find((r) => r.label === "Serve the app")?.detail).toBe("bun run dev");
    // Equal to its label once unwrapped: no second line.
    expect(rows.find((r) => r.label === "sleep 45")?.detail).toBeUndefined();
  });

  it("keeps a batch-steps row while a master watches with every batch thread done", () => {
    const master = (status: "watching" | "idle") =>
      activityRows({ meta: { id: "m", status, background: bg({ batch: { out: 0, total: 3 }, watchingSince: 5 }) }, agents: [], devServers: [], macCalls: [] });
    expect(master("watching").map((r) => [r.kind, r.label])).toEqual([["batch", "Batch steps"]]);
    expect(master("idle")).toEqual([]);
    // A finished batch keeps its tally: a master watching only its own monitor shows the monitor alone.
    const monitorOnly = activityRows({
      meta: { id: "m", status: "watching", background: bg({ batch: { out: 0, total: 3 }, tasks: [{ id: "t", label: "tail", kind: "monitor", startedAt: 1 }] }) },
      agents: [],
      devServers: [],
      macCalls: [],
    });
    expect(monitorOnly.map((r) => r.kind)).toEqual(["monitor"]);
  });

  it("is empty with nothing live, and hasActivity says so", () => {
    const rows = activityRows({ meta: { id: "s1", status: "idle", background: null }, agents: [], devServers: [], macCalls: [] });
    expect(rows).toEqual([]);
    expect(hasActivity(rows)).toBe(false);
    expect(hasActivity(activityRows({ meta: { id: "s1", status: "idle", background: null }, agents: [], devServers: [server], macCalls: [] }))).toBe(true);
  });
});

describe("threadServers", () => {
  it("keeps a pane-started run by its thread and a subagent's ledger row, and drops another thread's run", () => {
    const run = { ...server, key: "env/run1", sessionId: "s1", runId: "run1", resource: null };
    const subagentRow = { ...server, key: "env/r2", sessionId: "a1", resource: { id: "r2", sessionId: "a1" } };
    const otherRun = { ...server, key: "env/run2", sessionId: "s9", runId: "run2", resource: null };
    const noThread = { ...server, key: "env/run3", sessionId: null, runId: "run3", resource: null };
    const kept = threadServers([run, subagentRow, otherRun, noThread], new Set(["s1", "a1"]));
    expect(kept.map((s) => s.key)).toEqual(["env/run1", "env/r2"]);
  });
});

describe("rowStale", () => {
  const now = 10 * STALE_WATCH_MS;
  const stale = { status: "watching" as const, background: bg({ watchingSince: now - STALE_WATCH_MS - 1 }) };
  const old = now - STALE_WATCH_MS - 5;
  it("marks old tasks, crons and the batch of a stale watcher, never subagents, dev servers or Mac calls", () => {
    const row = (kind: string, since = old) => ({ key: kind, kind, label: kind, since }) as never;
    expect(rowStale(row("monitor"), stale, now)).toBe(true);
    expect(rowStale(row("cron"), stale, now)).toBe(true);
    expect(rowStale(row("batch"), stale, now)).toBe(true);
    expect(rowStale(row("monitor", now - 60_000), stale, now)).toBe(false);
    expect(rowStale(row("subagents"), stale, now)).toBe(false);
    expect(rowStale(row("dev"), stale, now)).toBe(false);
    expect(rowStale(row("mac"), stale, now)).toBe(false);
    expect(rowStale(row("monitor"), { status: "running", background: stale.background }, now)).toBe(false);
  });
});

describe("stopActivity", () => {
  it("routes each Stop to its own call", async () => {
    await stopActivity({ key: "k", kind: "shell", label: "x", since: 0, stop: { type: "task", sessionId: "s1", taskId: "t1" } });
    expect(stopTask).toHaveBeenCalledWith("s1", "t1");
    await stopActivity({ key: "k", kind: "dev", label: "x", since: 0, stop: { type: "dev", server } });
    expect(stopLiveServer).toHaveBeenCalledWith(server);
    const request = mac("running");
    await stopActivity({ key: "k", kind: "mac", label: "x", since: 0, stop: { type: "mac", request } });
    expect(stopMacBridgeAll).toHaveBeenCalledWith([request]);
    await stopActivity({ key: "k", kind: "subagents", label: "x", since: 0 });
    await stopAll("s1");
    expect(killBackground).toHaveBeenCalledWith("s1");
  });
});
