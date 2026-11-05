// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { resetTooltips, tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
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
/** A row's open control, laid over the row. */
const openOf = (kind: string): HTMLButtonElement => rowOf(kind).querySelector("[data-row-open]") as HTMLButtonElement;

describe("ActivitySection", () => {
  it("mounts no tooltip trigger for a label that fits", async () => {
    await act(async () => { await tooltipChunk.load(); warmTooltips(); });
    mount();
    expect(screen.getByText("Serve the app").getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

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
    expect(openOf("shell").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(openOf("shell"));
    expect(openOf("shell").getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/listening on :5173/)).toBeTruthy();
    expect(taskLog).toHaveBeenCalledWith("s1", "t1", undefined);
  });

  it("the shell row's open control opens its fold: the command first as $ <command>, then the output", async () => {
    mount();
    openOf("shell").focus();
    fireEvent.click(openOf("shell"));
    expect(openOf("shell").getAttribute("aria-expanded")).toBe("true");
    // While the first read is out: the console's box with skeleton lines, not a spinner.
    const loading = document.querySelector('[data-slot="task-log"]')!;
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="spinner"]')).toBeNull();
    const output = await screen.findByText(/listening on :5173/);
    // One console (CONSOLE: 12px mono on 20px lines, a pre that takes focus, capped at 240px) holds both.
    const log = document.querySelector<HTMLElement>('[data-slot="task-log"]')!;
    expect(log.tagName).toBe("PRE");
    expect(log.tabIndex).toBe(0);
    for (const cls of ["font-mono", "leading-5", "bg-card", "max-h-60", "focus-ring"]) expect(log.className).toContain(cls);
    const head = log.querySelector('[data-slot="task-command"]')!;
    expect(head.textContent).toBe("$ bun run dev --port 5173");
    // The command line comes before the output.
    expect(output.textContent!.indexOf("$ bun run dev --port 5173")).toBe(0);
    expect(output.textContent).toMatch(/listening on :5173/);
  });

  it("a row that opens is a container with its open control laid over it, Stop beside it, pressing to /12", () => {
    mount();
    for (const kind of ["shell", "dev"]) {
      const row = rowOf(kind);
      const open = openOf(kind);
      // A native button over the whole row: Enter and Space open it, and no button holds a button.
      expect(open.tagName).toBe("BUTTON");
      expect(open.getAttribute("type")).toBe("button");
      expect(open.className.split(/\s+/)).toEqual(expect.arrayContaining(["absolute", "inset-0"]));
      expect(row.getAttribute("role")).toBeNull();
      expect(row.hasAttribute("tabindex")).toBe(false);
      const stop = row.querySelector('[aria-label="Stop"]')!;
      expect(open.contains(stop)).toBe(false);
      expect(stop.closest("button")!.querySelector("button")).toBeNull();
      expect(row.className).toContain("hover:bg-foreground/5");
      expect(row.className).toContain("has-[>[data-row-open]:active]:bg-foreground/12");
      // What the row shows takes no pointer, so a click anywhere on it reaches the open control.
      expect(row.querySelector('[data-slot="item-content"]')!.className).toContain("pointer-events-none");
    }
    expect(openOf("shell").getAttribute("aria-label")).toBe("Serve the app");
    // A row with nothing to open is a plain line.
    expect(openOf("monitor")).toBeNull();
    fireEvent.click(rowOf("dev").querySelector('[aria-label="Stop"]')!);
    expect(openOf("shell").getAttribute("aria-expanded")).toBe("false");
  });

  it("the age and the spacer at a row's end take no pointer, Stop alone does: a click there reaches the open control", () => {
    mount();
    for (const kind of ["shell", "dev"]) {
      const row = rowOf(kind);
      const actions = row.querySelector('[data-slot="item-actions"]')!;
      expect(actions.className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-events-none", "relative"]));
      const stop = row.querySelector('[aria-label="Stop"]')!;
      expect(stop.className.split(/\s+/)).toContain("pointer-events-auto");
    }
    // A plain line has no open control, so its actions keep their own pointer.
    expect(rowOf("monitor").querySelector('[data-slot="item-actions"]')!.className).not.toContain("pointer-events-none");
  });

  it("a shell row whose command is its label opens on the output alone", async () => {
    const plain = { ...meta, background: { ...background, agents: [], tasks: [{ id: "t2", label: "sleep 90", kind: "shell" as const, startedAt: now, command: "sleep 90" }] } };
    render(<ActivityRows threadId="s1" rows={activityRows({ meta: plain, devServers: [], macCalls: [] })} meta={plain} />);
    fireEvent.click(openOf("shell"));
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
    fireEvent.click(openOf("shell"));
    expect(await screen.findByText("Couldn't read the output")).toBeTruthy();
    fireEvent.click(rowOf("shell").querySelector('[aria-label="Stop"]')!);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't stop it", { description: "Serve the app" }));
  });
  it("tooltips warming keep the scroller and an open log: no provider sits round them", async () => {
    resetTooltips();
    mount();
    fireEvent.click(openOf("shell"));
    await screen.findByText(/listening on :5173/);
    const scroller = document.querySelector<HTMLElement>('[data-slot="activity-scroller"]')!;
    const log = document.querySelector<HTMLElement>('[data-slot="task-log"]')!;
    scroller.scrollTop = 30;
    log.scrollTop = 12;
    await tooltipChunk.load();
    act(() => warmTooltips());
    // The Stops are the primitive's tooltips now; the scroller and the log are the same nodes, still scrolled.
    expect(document.querySelector('[data-slot="activity-scroller"]')).toBe(scroller);
    expect(document.querySelector('[data-slot="task-log"]')).toBe(log);
    expect(scroller.scrollTop).toBe(30);
    expect(log.scrollTop).toBe(12);
    resetTooltips();
  });

  it("a closing log keeps its command and output until its close has run, and stops asking as the close starts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The dom setup turns Base UI's animation wait off; this test needs it on.
    const flags = globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean };
    let finished = false;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => (finish = () => ((finished = true), resolve())));
    const running = {
      finished: done,
      pending: false,
      get playState() {
        return finished ? "finished" : "running";
      },
      effect: { getTiming: () => ({ duration: 150, iterations: 1 }) },
    } as unknown as Animation;
    const getAnimations = Element.prototype.getAnimations;
    // The panel's height transition (`.collapsible-resize`), which jsdom reads from the sheet.
    const sheet = document.head.appendChild(document.createElement("style"));
    sheet.textContent = '[data-slot="collapsible-content"] { transition-duration: 150ms; }';
    // jsdom lays nothing out: the open panel measures 120px, so the close has a height to run from.
    const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) {
        return this.matches('[data-slot="collapsible-content"]') ? 120 : 0;
      },
    });
    try {
      mount();
      fireEvent.click(openOf("shell"));
      await screen.findByText(/listening on :5173/);
      // The close's height animation is still running.
      flags.BASE_UI_ANIMATIONS_DISABLED = false;
      Element.prototype.getAnimations = () => [running];
      fireEvent.click(openOf("shell"));
      expect(openOf("shell").getAttribute("aria-expanded")).toBe("false");
      const asked = taskLog.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(taskLog.mock.calls.length).toBe(asked);
      expect(document.querySelector('[data-slot="task-command"]')?.textContent).toBe("$ bun run dev --port 5173");
      expect(document.body.textContent).toContain("listening on :5173");
      await act(async () => {
        finish();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(document.querySelector('[data-slot="task-log"]')).toBeNull();
      expect(document.querySelector('[data-slot="task-command"]')).toBeNull();
    } finally {
      Element.prototype.getAnimations = getAnimations;
      flags.BASE_UI_ANIMATIONS_DISABLED = true;
      sheet.remove();
      Object.defineProperty(Element.prototype, "scrollHeight", scrollHeight);
      vi.useRealTimers();
    }
  });
});
