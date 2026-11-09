// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import type { ComputerEntry } from "../../lib/computerSessions";

const { stopComputer, toastError } = vi.hoisted(() => ({ stopComputer: vi.fn(() => Promise.resolve()), toastError: vi.fn() }));
vi.mock("../../lib/computerSessions", () => ({ stopComputer, useComputerEntries: () => [] }));
vi.mock("../../lib/computerPreview", () => ({
  useComputerPreview: () => ({ state: { status: "starting", width: 960, height: 600 }, retry: vi.fn() }),
}));
vi.mock("../../lib/tcserver/commands", () => ({ stopTask: vi.fn(), taskLog: vi.fn(), killBackground: vi.fn() }));
vi.mock("../../lib/devServers", () => ({ stopLiveServer: vi.fn(), useLiveDevServers: () => [] }));
vi.mock("../../lib/macBridge", () => ({ stopMacBridgeAll: vi.fn(), useMacBridgeRunning: () => [] }));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMeta: () => null, useSessionMetas: () => [] }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { activityRows } from "../../lib/activity";
import { ActivityRows } from "./ActivitySection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const now = Date.now();
const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "s1",
  since: now - 3 * 60_000,
  lastCallAt: now,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "process",
  ...over,
});
const entry = (over: Partial<ComputerSessionRow> = {}, previewable = true, host = "local"): ComputerEntry => ({
  host,
  row: row(over),
  previewable,
  ...(previewable ? { previewHost: "local", previewKey: "s1" } : {}),
});
const meta = { id: "s1", status: "running" as const, background: { tasks: [], agents: [], batch: null, watchingSince: null } };

function mount(...entries: ComputerEntry[]) {
  const rows = activityRows({ meta, devServers: [], macCalls: [], computer: entries });
  render(<ActivityRows threadId="s1" rows={rows} meta={meta} />);
}
const computerRow = (): HTMLElement => document.querySelector('[data-kind="computer"]') as HTMLElement;
const openControl = (): HTMLButtonElement | null => computerRow().querySelector("[data-row-open]");

describe("the Computer row", () => {
  it("is one line: its glyph, the window in its app, the tier in a person's words after it, the age and Stop", () => {
    mount(entry());
    const r = computerRow();
    expect(r.className).toContain("min-h-7");
    expect(r.querySelector("svg")).toBeTruthy();
    expect(r.textContent).toContain("Untitled in TextEdit");
    const tier = r.querySelector('[data-slot="activity-tier"]')!;
    expect(tier.textContent).toBe("to the app");
    expect(tier.className).toContain("text-xs");
    expect(tier.className).toContain("text-muted-foreground");
    expect(r.textContent).toContain("3m");
    expect(r.textContent).not.toMatch(/\b(ax|process|session)\b/);
    expect(r.querySelector('[aria-label="Stop"]')).toBeTruthy();
  });

  it("Stop is computer.stop on the session's own host, and a failure says so", async () => {
    const e = entry({}, false, "env_box");
    mount(e);
    const stop = () => computerRow().querySelector<HTMLButtonElement>('[aria-label="Stop"]')!;
    fireEvent.click(stop());
    expect(stopComputer).toHaveBeenCalledWith(e);
    await vi.waitFor(() => expect(stop().disabled).toBe(false));
    stopComputer.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    await act(async () => fireEvent.click(stop()));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't stop it", { description: "Untitled in TextEdit" }));
  });

  it("opens in place onto the preview, with no fold to animate its height", async () => {
    mount(entry());
    const open = openControl()!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(open.getAttribute("aria-label")).toBe("Untitled in TextEdit, to the app");
    fireEvent.click(open);
    expect(openControl()!.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("img", { name: "Preview of Untitled in TextEdit" })).toBeTruthy();
    const holder = computerRow().closest('[data-slot="computer-row"]')!;
    expect(holder.querySelector('[data-slot="collapsible-content"]')).toBeNull();
    fireEvent.click(openControl()!);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not open when this desktop cannot preview it and nothing waits", () => {
    mount(entry({}, false, "env_box"));
    expect(openControl()).toBeNull();
  });

  it("opens onto the held line, or the card waiting on the Mac, where it cannot preview", async () => {
    mount(entry({ running: { tool: "computer_act", words: "Waiting for the Mac to be free", startedAt: now, held: true } }, false, "env_box"));
    fireEvent.click(openControl()!);
    const held = await vi.waitFor(() => document.querySelector('[data-slot="computer-held"]')!);
    expect(held.textContent).toContain("Waiting for the Mac to be free");
    expect(screen.queryByRole("img")).toBeNull();
    cleanup();
    mount(entry({ asking: { line: "Click Save in TextEdit?" } }, false, "env_box"));
    fireEvent.click(openControl()!);
    const asking = await vi.waitFor(() => document.querySelector('[data-slot="computer-asking"]')!);
    expect(asking.getAttribute("data-state")).toBe("waiting");
    expect(asking.textContent).toContain("Click Save in TextEdit?");
  });
});
