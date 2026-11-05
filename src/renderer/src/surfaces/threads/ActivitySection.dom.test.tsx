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
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMeta: () => null, useSessionMetas: () => [] }));

// jsdom has no Web Animations; Base UI's collapsible asks the panel for its running ones.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { activityRows } from "../../lib/activity";
import { ActivityRows } from "./ActivitySection";

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
const rows = activityRows({ meta, devServers: [server], macCalls: [] });

function mount() {
  render(<ActivityRows threadId="s1" rows={rows} meta={meta} />);
}
const rowOf = (kind: string): HTMLElement => document.querySelector(`[data-kind="${kind}"]`) as HTMLElement;

describe("ActivitySection", () => {
  it("lists the thread's own work oldest first, each one plain line, and never a subagents row: Agents lists them", () => {
    mount();
    const kinds = [...document.querySelectorAll("[data-kind]")].map((e) => e.getAttribute("data-kind"));
    expect(kinds).toEqual(["monitor", "shell", "dev"]);
    expect(document.body.textContent).not.toContain("subagents");
    // Folded, a shell row is its label alone: the command shows only in its fold.
    expect(rowOf("shell").textContent).toContain("Serve the app");
    expect(document.body.textContent).not.toContain("bun run dev --port 5173");
    expect(rowOf("shell").className).toContain("min-h-7");
    expect(rowOf("shell").className).toContain("py-0");
    expect(rowOf("dev").textContent).toContain("Dev server :5173");
    // Live subagents carry the wait, so nothing is stale yet.
    expect(rowOf("monitor").querySelector(".text-warning")).toBeNull();
    expect(rowOf("shell").querySelector(".text-warning")).toBeNull();
    expect(rowOf("shell").textContent).toContain("10m");
    // Each task and the dev server carries its Stop.
    for (const kind of ["monitor", "shell", "dev"]) expect(rowOf(kind).querySelector('[aria-label="Stop"]')).not.toBeNull();
  });

  it("Stop reaches the task's session.stopTask and the dev server's own stop", () => {
    mount();
    fireEvent.click(rowOf("shell").querySelector('[aria-label="Stop"]')!);
    expect(stopTask).toHaveBeenCalledWith("s1", "t1");
    fireEvent.click(rowOf("dev").querySelector('[aria-label="Stop"]')!);
    expect(stopLiveServer).toHaveBeenCalledWith(server);
  });

  it("clicking the shell row opens its log from session.taskLog", async () => {
    mount();
    expect(rowOf("shell").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rowOf("shell"));
    expect(rowOf("shell").getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/listening on :5173/)).toBeTruthy();
    expect(taskLog).toHaveBeenCalledWith("s1", "t1", undefined);
  });

  it("Enter on the shell row opens its fold: the command first as $ <command>, then the output", async () => {
    mount();
    rowOf("shell").focus();
    fireEvent.keyDown(rowOf("shell"), { key: "Enter" });
    expect(rowOf("shell").getAttribute("aria-expanded")).toBe("true");
    const head = document.querySelector('[data-slot="task-command"]')!;
    expect(head.textContent).toBe("$ bun run dev --port 5173");
    expect(head.className).toContain("font-mono");
    const output = await screen.findByText(/listening on :5173/);
    // The command line comes before the output.
    expect(head.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a shell row whose command is its label opens on the output alone", async () => {
    const plain = { ...meta, background: { ...background, agents: [], tasks: [{ id: "t2", label: "sleep 90", kind: "shell" as const, startedAt: now, command: "sleep 90" }] } };
    render(<ActivityRows threadId="s1" rows={activityRows({ meta: plain, devServers: [], macCalls: [] })} meta={plain} />);
    fireEvent.click(rowOf("shell"));
    expect(await screen.findByText(/listening on :5173/)).toBeTruthy();
    expect(document.querySelector('[data-slot="task-command"]')).toBeNull();
  });

  it("turns an old task's age amber once the thread waits on its own tasks alone", () => {
    const alone = { ...meta, background: { ...background, agents: [] } };
    render(<ActivityRows threadId="s1" rows={activityRows({ meta: alone, devServers: [], macCalls: [] })} meta={alone} />);
    expect(rowOf("monitor").querySelector(".text-warning")?.textContent).toBe("1h");
    expect(rowOf("shell").querySelector(".text-warning")).toBeNull();
  });

  it("says a failed log read and a failed Stop instead of looking quiet", async () => {
    taskLog.mockImplementationOnce(() => Promise.reject(new Error("linkDown")));
    stopTask.mockImplementationOnce(() => Promise.reject(new Error("no live harness")));
    mount();
    fireEvent.click(rowOf("shell"));
    expect(await screen.findByText("Couldn't read the output")).toBeTruthy();
    fireEvent.click(rowOf("shell").querySelector('[aria-label="Stop"]')!);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't stop it", { description: "Serve the app" }));
  });
});
