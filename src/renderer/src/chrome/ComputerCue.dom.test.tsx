// @vitest-environment jsdom
/**
 * The title bar's computer cue: nothing with no session this desktop can
 * draw, the state's glyph and words (working's still dot, Needs you in
 * amber, Waiting for the Mac), a click that opens the panel on Computer and
 * closes it again, nothing opened on its own, and the no-room state the
 * panel toggle has.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";

vi.mock("../lib/native", () => ({ nativePlatform: () => "darwin" }));
vi.mock("../lib/nativeWeb", () => ({ isWebMode: () => false }));

import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { computerCue } from "../lib/computerSection";
import { computerSessionsStore, type ComputerEntry } from "../lib/computerSessions";
import { NO_ROOM_LABEL, rightPanel } from "../lib/rightPanel";
import { sessionStore } from "../lib/tcserver/store";
import { FakeMetaLink, wireMeta } from "../test/fakeMetaLink";
import { ComputerCue, ComputerCueView } from "./ComputerCue";
import { ComputerCueEndGroup } from "./ComputerCue.preview";
import FIXTURES from "./ComputerCue.preview.fixtures";

const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "root",
  since: 1,
  lastCallAt: 10,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "ax",
  ...over,
});
const entry = (over: Partial<ComputerSessionRow> = {}, previewable = true): ComputerEntry => ({ host: "local", row: row(over), previewable, ...(previewable ? { previewHost: "local", previewKey: "root" } : {}) });
const running = (words: string, held = false) => ({ tool: "computer_act", words, startedAt: 1, ...(held ? { held: true as const } : {}) });
const button = () => document.querySelector<HTMLElement>("[data-computer-cue]");
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  rightPanel.reset();
});

describe("computerCue", () => {
  it("is nothing with no live session, or none this desktop can draw", () => {
    expect(computerCue([])).toBeNull();
    expect(computerCue([entry({}, false)])).toBeNull();
  });

  it("says Using and the app while it works or sits between calls, with what it does as its line", () => {
    expect(computerCue([entry({ running: running("Clicking Save in TextEdit") })])).toEqual({ state: "working", label: "Using TextEdit", line: "Computer use: Clicking Save in TextEdit" });
    expect(computerCue([entry()])).toEqual({ state: "working", label: "Using TextEdit", line: "Computer use: Untitled in TextEdit" });
    expect(computerCue([entry({ apps: [{ name: "Finder", bundleId: null, window: null }] })])).toMatchObject({ label: "Using Finder", line: "Computer use: Finder" });
    expect(computerCue([entry({ apps: [] })])).toEqual({ state: "working", label: "Using the Mac", line: "Computer use: Starting" });
  });

  it("says Needs you while a card waits, and Waiting for the Mac while a step is held", () => {
    expect(computerCue([entry({ asking: { line: "Click Save in TextEdit?" }, running: running("Waiting for your approval", true) })])).toEqual({
      state: "waiting",
      label: "Needs you",
      line: "Computer use: Click Save in TextEdit?",
    });
    expect(computerCue([entry({ running: running("Waiting for the Mac to be free, 2nd in line", true) })])).toEqual({
      state: "queued",
      label: "Waiting for the Mac",
      line: "Computer use: Waiting for the Mac to be free, 2nd in line",
    });
  });

  it("with several sessions the loudest leads: a card, then a hold, then the one that acted last", () => {
    const working = entry({ threadId: "a", lastCallAt: 50, apps: [{ name: "Mail", bundleId: null, window: "Inbox" }], running: running("Clicking Send in Mail") });
    const held = entry({ threadId: "b", lastCallAt: 20, running: running("Waiting for the Mac to be free", true) });
    const asking = entry({ threadId: "c", lastCallAt: 5, asking: { line: "Click Save in TextEdit?" } });
    expect(computerCue([working, held, asking])?.state).toBe("waiting");
    expect(computerCue([working, held])?.state).toBe("queued");
    expect(computerCue([entry({ threadId: "d", lastCallAt: 1 }), working])).toMatchObject({ state: "working", label: "Using Mail" });
  });
});

describe("ComputerCueView", () => {
  const cue = (e: ComputerEntry) => computerCue([e])!;

  it("is a quiet 24px row control: the state's glyph 8px from 12px muted words, named by its line", () => {
    render(<ComputerCueView cue={cue(entry({ running: running("Clicking Save in TextEdit") }))} pressed={false} onClick={() => {}} />);
    const el = screen.getByRole("button", { name: "Computer use: Clicking Save in TextEdit" });
    expect(el.textContent).toBe("Using TextEdit");
    const cls = el.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["h-6", "px-2", "gap-2", "text-xs", "text-muted-foreground", "hover:bg-foreground/5", "active:bg-foreground/12"]));
    expect(cls).not.toContain("hover:bg-foreground/7");
    // working is the still dot: the thread's own turn already spins
    expect(el.querySelector('[data-slot="working-dot"]')).not.toBeNull();
    expect(el.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("leads with waiting's amber and says Needs you in amber words while a card waits", () => {
    render(<ComputerCueView cue={cue(entry({ asking: { line: "Click Save in TextEdit?" } }))} pressed={false} onClick={() => {}} />);
    expect(button()!.getAttribute("data-state")).toBe("waiting");
    const mark = button()!.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("waiting");
    expect(mark.className).toContain("text-warning");
    expect(screen.getByText("Needs you").closest(".text-warning")).not.toBeNull();
    expect(button()!.getAttribute("aria-label")).toBe("Computer use: Click Save in TextEdit?");
  });

  it("draws the dashed ring and Waiting for the Mac while a step is held", () => {
    render(<ComputerCueView cue={cue(entry({ running: running("Waiting for the Mac to be free", true) }))} pressed={false} onClick={() => {}} />);
    expect(button()!.querySelector('[data-slot="status-mark"]')!.getAttribute("data-state")).toBe("queued");
    expect(button()!.textContent).toBe("Waiting for the Mac");
    expect(button()!.querySelector(".text-warning")).toBeNull();
  });

  it("keeps the control when its words change", () => {
    const view = render(<ComputerCueView cue={cue(entry())} pressed={false} onClick={() => {}} />);
    const el = button()!;
    view.rerender(<ComputerCueView cue={cue(entry({ asking: { line: "Click Save in TextEdit?" } }))} pressed={false} onClick={() => {}} />);
    expect(button()).toBe(el);
    expect(el.querySelector('[data-slot="morph-text"]')).not.toBeNull();
  });

  it("fades in on entry on a wrapper and carries the pressed fill", () => {
    render(<ComputerCueView cue={cue(entry())} pressed onClick={() => {}} />);
    const fade = button()!.parentElement!.className;
    expect(fade).toContain("starting:opacity-0");
    expect(fade).toContain("duration-(--dur-fast)");
    expect(fade).toContain("motion-reduce:transition-opacity");
    const cls = button()!.className;
    expect(cls).not.toContain("transition-opacity");
    expect(cls).toContain("aria-pressed:bg-muted");
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("with no room for the panel is aria-disabled, says why on hover and does nothing on click", async () => {
    let clicks = 0;
    render(<ComputerCueView cue={cue(entry())} pressed room={false} onClick={() => clicks++} />);
    const el = button()!;
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(el);
    expect(clicks).toBe(0);
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    fireEvent.mouseEnter(el);
    fireEvent.mouseMove(el);
    await waitFor(() => expect(screen.getByText(NO_ROOM_LABEL)).toBeTruthy(), { timeout: 1500 });
  });

  it("renders every preview fixture, the zero one with no cue beside ⋯ and Panel", () => {
    for (const f of FIXTURES) {
      const { container, unmount } = render(<ComputerCueEndGroup {...f.props} />);
      expect([f.name, !!container.querySelector("[data-computer-cue]")]).toEqual([f.name, f.props.cue !== null]);
      expect(container.querySelector('[aria-label="Thread menu"]')).not.toBeNull();
      unmount();
    }
  });
});

describe("ComputerCue", () => {
  let link: FakeMetaLink;
  const setRows = (rows: ComputerSessionRow[], host = "local"): void =>
    act(() => computerSessionsStore.setState((s) => ({ byHost: { ...s.byHost, [host]: rows } })));

  beforeEach(async () => {
    sessionStore.reset();
    computerSessionsStore.setState({ byHost: {}, serviceByHost: {} });
    link = new FakeMetaLink();
    link.metas = [wireMeta("root", { status: "running" }), wireMeta("kid", { parentId: "root", status: "running" }), wireMeta("other", { status: "running" })];
    sessionStore.attach(link);
    await sessionStore.ready();
  });
  afterEach(() => sessionStore.reset());

  it("renders nothing while no session is live in the thread's tree", async () => {
    setRows([row({ threadId: "other" })]);
    render(<ComputerCue threadId="root" />);
    await flush();
    expect(button()).toBeNull();
  });

  it("shows for the thread's own session and for a subagent's, and leaves at once when the turn settles", async () => {
    render(<ComputerCue threadId="root" />);
    await flush();
    setRows([row({ running: running("Clicking Save in TextEdit") })]);
    expect(button()!.textContent).toBe("Using TextEdit");
    setRows([row({ threadId: "kid", apps: [{ name: "Mail", bundleId: null, window: "Inbox" }] })]);
    // the old words leave before the new arrive (MorphText)
    await waitFor(() => expect(button()!.textContent).toBe("Using Mail"));
    expect(button()!.getAttribute("aria-label")).toBe("Computer use: Inbox in Mail");
    setRows([]);
    expect(button()).toBeNull();
  });

  it("closed stays closed: a session going live opens nothing, and the click is the only way in", async () => {
    render(<ComputerCue threadId="root" />);
    await flush();
    setRows([row({ running: running("Clicking Save in TextEdit") })]);
    expect(rightPanel.get("root").open).toBe(false);
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button()!);
    expect(rightPanel.get("root")).toMatchObject({ open: true, section: "computer" });
    act(() => rightPanel.setShown("root", "computer"));
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button()!);
    expect(rightPanel.get("root").open).toBe(false);
  });

  it("an open panel keeps its section when a session goes live, and when a card waits", async () => {
    act(() => {
      rightPanel.open("root", "notes");
      rightPanel.setShown("root", "notes");
    });
    render(<ComputerCue threadId="root" />);
    await flush();
    setRows([row({ running: running("Clicking Save in TextEdit") })]);
    expect(rightPanel.get("root")).toMatchObject({ open: true, section: "notes" });
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    setRows([row({ asking: { line: "Click Save in TextEdit?" } })]);
    expect(button()!.getAttribute("data-state")).toBe("waiting");
    await waitFor(() => expect(button()!.textContent).toBe("Needs you"));
    expect(rightPanel.get("root").section).toBe("notes");
    // the click moves it to Computer
    fireEvent.click(button()!);
    expect(rightPanel.get("root").section).toBe("computer");
  });

  it("reads the thread a pane shows: a master's open child", async () => {
    setRows([row({ threadId: "other", apps: [{ name: "Finder", bundleId: null, window: null }] })]);
    render(<ComputerCue threadId="root" />);
    await flush();
    expect(button()).toBeNull();
    act(() => rightPanel.showThread("root", { id: "other", environmentId: "local" }));
    await flush();
    expect(button()!.textContent).toBe("Using Finder");
    // the click opens the pane's own panel, on the shown thread's section
    fireEvent.click(button()!);
    expect(rightPanel.get("root")).toMatchObject({ open: true, section: "computer" });
  });

  it("never shows where the section cannot draw: a box thread driving another Mac", async () => {
    setRows([row({ macPeer: "env_other_mac", macName: "Studio" })]);
    render(<ComputerCue threadId="root" />);
    await flush();
    expect(button()).toBeNull();
  });

  it("no room: disabled, and a click opens nothing", async () => {
    setRows([row()]);
    render(<ComputerCue threadId="root" room={false} />);
    await flush();
    expect(button()!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button()!);
    expect(rightPanel.get("root").open).toBe(false);
  });
});
