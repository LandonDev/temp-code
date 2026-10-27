// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundWork } from "@server/shared/events";
import { STALE_WATCH_MS } from "@server/shared/watch";
import type { LiveServer } from "../../lib/devServers";

const { stopTask, taskLog, stopLiveServer } = vi.hoisted(() => ({
  stopTask: vi.fn(() => Promise.resolve()),
  taskLog: vi.fn(() => Promise.resolve({ source: "file", data: "listening on :5173\n", next: 19 })),
  stopLiveServer: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/tcserver/commands", () => ({ stopTask, taskLog, killBackground: vi.fn() }));
vi.mock("../../lib/devServers", () => ({ stopLiveServer, useLiveDevServers: () => [] }));
vi.mock("../../lib/macBridge", () => ({ stopMacBridgeAll: vi.fn(), useMacBridgeRunning: () => [] }));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMeta: () => null, useSessionMetas: () => [] }));

// jsdom has no Web Animations; Base UI's collapsible asks the panel for its running ones.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { activityRows } from "../../lib/activity";
import { ActivityRows, ageText } from "./ActivitySection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const now = Date.now();
const server: LiveServer = {
  key: "env/r1",
  environmentId: "env",
  title: "bun run dev",
  thread: "t",
  port: { number: 5173, environmentId: "env", forwards: undefined },
  runId: null,
  resource: { id: "r1", sessionId: "s1" },
  startedAt: now - 2 * 60_000,
};
const background: BackgroundWork = {
  tasks: [
    { id: "t1", label: "Serve the app", kind: "shell", startedAt: now - 10 * 60_000, command: "bun run dev --port 5173", callId: "c1" },
    { id: "m1", label: "Tail the deploy log", kind: "monitor", startedAt: now - 2 * STALE_WATCH_MS },
  ],
  agents: ["a1", "a2", "a3"],
  batch: null,
  watchingSince: now - 2 * STALE_WATCH_MS,
};
const meta = { id: "s1", status: "watching" as const, background };
const rows = activityRows({ meta, agents: [{ busySince: now - 60_000, createdAt: 0 }], devServers: [server], macCalls: [] });

function mount(onOpenAgents = vi.fn()) {
  render(<ActivityRows threadId="s1" rows={rows} meta={meta} onOpenAgents={onOpenAgents} />);
  return onOpenAgents;
}
const rowOf = (kind: string): HTMLElement => document.querySelector(`[data-kind="${kind}"]`) as HTMLElement;

describe("ActivitySection", () => {
  it("lists subagents first, then oldest first, the shell's command under it and the stale monitor's age in amber", () => {
    mount();
    const kinds = [...document.querySelectorAll("[data-kind]")].map((e) => e.getAttribute("data-kind"));
    expect(kinds).toEqual(["subagents", "monitor", "shell", "dev"]);
    expect(rowOf("subagents").textContent).toContain("3 subagents");
    expect(rowOf("shell").textContent).toContain("bun run dev --port 5173");
    expect(rowOf("dev").textContent).toContain("Dev server :5173");
    expect(rowOf("monitor").querySelector(".text-warning")?.textContent).toBe("1h");
    expect(rowOf("shell").querySelector(".text-warning")).toBeNull();
    expect(rowOf("shell").textContent).toContain("10m");
    // The subagents row has no Stop; its slot stays so the ages line up.
    expect(rowOf("subagents").querySelector('[aria-label="Stop"]')).toBeNull();
  });

  it("Stop reaches the task's session.stopTask and the dev server's own stop", () => {
    mount();
    fireEvent.click(rowOf("shell").querySelector('[aria-label="Stop"]')!);
    expect(stopTask).toHaveBeenCalledWith("s1", "t1");
    fireEvent.click(rowOf("dev").querySelector('[aria-label="Stop"]')!);
    expect(stopLiveServer).toHaveBeenCalledWith(server);
  });

  it("the subagents row opens the Agents section", () => {
    const onOpenAgents = mount();
    fireEvent.click(rowOf("subagents"));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it("clicking the shell row opens its log from session.taskLog", async () => {
    mount();
    expect(rowOf("shell").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rowOf("shell"));
    expect(rowOf("shell").getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/listening on :5173/)).toBeTruthy();
    expect(taskLog).toHaveBeenCalledWith("s1", "t1", undefined);
  });

  it("writes ages in whole minutes", () => {
    expect(ageText(10_000)).toBe("<1m");
    expect(ageText(12 * 60_000)).toBe("12m");
    expect(ageText((2 * 60 + 14) * 60_000)).toBe("2h 14m");
    expect(ageText(3 * 3_600_000)).toBe("3h");
  });
});
