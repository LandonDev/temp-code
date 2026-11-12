// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerHistoryCall, ComputerHistoryStep, ComputerHistoryStepAnswer, ComputerSessionRow } from "@server/shared/contract-computer";
import type { PreviewState } from "../../../lib/computerPreview";
import type { ComputerSectionData } from "../../../lib/computerSection";
import type { ComputerEntry } from "../../../lib/computerSessions";

const h = vi.hoisted(() => ({
  stopComputer: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  openLightbox: vi.fn(),
  readStep: vi.fn(),
  loadOlder: vi.fn(() => Promise.resolve()),
  retry: vi.fn(),
  pictureGone: vi.fn(),
  preview: { state: { status: "starting" } as unknown, runs: [] as boolean[], entries: [] as unknown[], retry: vi.fn() },
}));
vi.mock("../../../lib/computerSessions", () => ({ stopComputer: h.stopComputer, useComputerEntries: () => [] }));
vi.mock("../../../lib/tcserver/commands", () => ({ stopTask: vi.fn(), taskLog: vi.fn(), killBackground: vi.fn() }));
vi.mock("../../../lib/devServers", () => ({ stopLiveServer: vi.fn(), useLiveDevServers: () => [] }));
vi.mock("../../../lib/macBridge", () => ({ stopMacBridgeAll: vi.fn(), useMacBridgeRunning: () => [] }));
vi.mock("../../../lib/tcserver/store", () => ({
  useSessionMeta: () => null,
  useSessionMetas: () => [{ id: "sub1", title: "Fill in the form" }],
  useSessionTitles: (ids: readonly string[]) => ids.map((id) => (id === "sub1" ? "Fill in the form" : "")).join("\u0000"),
}));
vi.mock("../../../lib/computerSection", () => ({ useComputerSection: () => ({ entries: [], keys: [], histories: {}, exists: false, live: false }) }));
vi.mock("../../../chrome/lightboxStore", () => ({ openLightbox: h.openLightbox }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));
// The stream: what the hook says, and whether it was asked to run.
vi.mock("../../../lib/computerPreview", () => ({
  useComputerPreview: (entry: unknown, opts: { run: boolean }) => {
    h.preview.runs.push(opts.run);
    h.preview.entries.push(entry);
    return { state: h.preview.state, retry: h.preview.retry };
  },
}));
vi.mock("../../../lib/computerHistory", async (original) => ({
  ...(await original<typeof import("../../../lib/computerHistory")>()),
  readHistoryStep: h.readStep,
  loadOlderHistory: h.loadOlder,
  retryHistory: h.retry,
  markPictureGone: h.pictureGone,
}));

import { COMPUTER_TIER_WORDS } from "@server/shared/statusWords";
import { clockTime } from "../../../lib/duration";
import { ComputerSectionBody, runningLines } from "./ComputerSection";
import { PICTURE_DIM_MS, STEP_MEDIA_LIMIT, StepMediaCache } from "./stepMedia";
import { rowsOf } from "../../../lib/computerHistory";

// ── what the tests build ──

const AT = new Date(2026, 10, 11, 14, 4).getTime();
const step = (verb: string, object = "", over: Partial<ComputerHistoryStep> = {}): ComputerHistoryStep => ({
  kind: "click",
  verb,
  object,
  inApp: object ? `${object} in TextEdit` : "in TextEdit",
  state: "ok",
  tier: "ax",
  ...over,
});
const call = (n: number, over: Partial<ComputerHistoryCall> = {}): ComputerHistoryCall => ({
  n,
  turn: 1,
  at: AT + n * 1000,
  endedAt: AT + n * 1000 + 400,
  state: "done",
  app: "TextEdit",
  window: "Untitled",
  steps: [step("Clicked", `Step ${n}`)],
  text: false,
  picture: { width: 960, height: 804, at: AT + n * 1000 + 450 },
  rev: 3,
  ...over,
});
const running = (n: number, over: Partial<ComputerHistoryCall> = {}): ComputerHistoryCall =>
  call(n, { state: "running", endedAt: undefined, picture: undefined, rev: 1, steps: [step("Clicking", "Save", { state: undefined, tier: undefined })], ...over });
const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "t1",
  since: AT,
  lastCallAt: AT,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "ax",
  ...over,
});
const entry = (over: Partial<ComputerSessionRow> = {}, host = "local"): ComputerEntry => {
  const r = row(over);
  return { host, row: r, previewable: true, previewHost: "local", previewKey: r.threadId };
};
const data = (calls: ComputerHistoryCall[], entries: ComputerEntry[] = [], over: Partial<ComputerSectionData["histories"][string]> = {}): ComputerSectionData => ({
  entries,
  keys: [{ key: "t1", threadId: "t1" }],
  histories: { t1: { born: 1, calls, more: false, status: "ready", ...over } },
  exists: true,
  live: entries.length > 0,
});
const live = (over: Partial<Extract<PreviewState, { status: "live" }>> = {}): PreviewState => ({ status: "live", app: "TextEdit", window: "Untitled", width: 960, height: 600, drawn: true, ...over });

/** A step read the test settles by hand. */
function deferredReads() {
  const waiting = new Map<number, (a: ComputerHistoryStepAnswer) => void>();
  h.readStep.mockImplementation((_key: string, n: number) => new Promise<ComputerHistoryStepAnswer>((resolve) => waiting.set(n, resolve)));
  return {
    asked: () => [...waiting.keys()],
    answer: async (n: number, a: ComputerHistoryStepAnswer = { picture: { data: btoa(`jpeg ${n}`), mimeType: "image/jpeg", width: 960, height: 804, at: 1 } }) => {
      await act(async () => {
        waiting.get(n)?.(a);
        waiting.delete(n);
      });
    },
  };
}
const picture = (n: number): ComputerHistoryStepAnswer => ({ picture: { data: btoa(`jpeg ${n}`), mimeType: "image/jpeg", width: 960, height: 804, at: 1 } });

let urls = 0;
const revoked: string[] = [];
beforeEach(() => {
  urls = 0;
  revoked.length = 0;
  h.preview.state = { status: "starting" };
  h.preview.runs.length = 0;
  h.preview.entries.length = 0;
  h.readStep.mockReset();
  h.readStep.mockImplementation(async (_key: string, n: number) => picture(n));
  URL.createObjectURL = vi.fn(() => `blob:${++urls}`);
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as never;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 320 });
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const flush = () => act(async () => {});
function mount(d: ComputerSectionData) {
  const view = render(<ComputerSectionBody threadId="t1" data={d} />);
  return { ...view, again: (next: ComputerSectionData) => view.rerender(<ComputerSectionBody threadId="t1" data={next} />) };
}
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-slot="step"]')];
const rowButton = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-row="${id}"]`)!;
const openRow = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-slot="step"][data-open]');
const words = (el: Element | null): string => (el?.querySelector("button")?.textContent ?? "").replace(/\s+/g, " ").trim();
const box = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-face]");
const lineUnder = (): string => document.querySelector('[data-slot="computer-line"]')?.textContent ?? "";
const runningRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-slot="step-running"]')];
const stepList = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="computer-steps"]')!;

// ── following ──

describe("following", () => {
  it("the picture is live, the open row is the last step that finished, and the running call is one line above it", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2, { steps: [step("Typed", "into Save As", { kind: "type", target: '"Total"', tier: "ax" })] }), running(3)], [entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT } })]));
    await flush();
    // the live box: a picture, not a button, named for the window
    expect(box()!.getAttribute("role")).toBe("img");
    expect(box()!.getAttribute("data-face")).toBe("live");
    expect(box()!.getAttribute("aria-label")).toBe("Live view of Untitled in TextEdit");
    expect(h.preview.runs.at(-1)).toBe(true);
    // one line for the running call, its state the still dot, the app left to the session row above
    expect(runningRows()).toHaveLength(1);
    expect(runningRows()[0].getAttribute("data-state")).toBe("working");
    expect(runningRows()[0].textContent).toBe("ClickingSave");
    expect(runningRows()[0].querySelector('[data-slot="working-dot"]')).toBeTruthy();
    expect(runningRows()[0].querySelector("button")).toBeNull();
    // the open row: the newest finished step, with its facts
    expect(words(openRow())).toBe("Typedinto Save As");
    expect(openRow()!.className).toContain("bg-muted");
    expect(openRow()!.querySelector("button")!.getAttribute("aria-current")).toBe("true");
    const facts = [...openRow()!.querySelectorAll('[data-slot="facts"] > span')].map((s) => s.textContent);
    expect(facts).toEqual([COMPUTER_TIER_WORDS.ax, '"Total"', clockTime(AT + 2400)]);
    // the rest are one line each, and only the oldest names its app
    expect(rows().map(words)).toEqual(["Typedinto Save As", "ClickedStep 1 in TextEdit"]);
    expect(rows()[1].querySelector('[data-slot="step-detail"]')).toBeNull();
    // nothing kept is fetched while the stream is the picture
    expect(h.readStep).not.toHaveBeenCalled();
    // no Go live: nothing is pinned
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    expect(document.querySelector('[data-slot="computer-section"]')!.hasAttribute("data-following")).toBe(true);
  });

  it("the session row says the window in its app, with Stop, and Stop is computer.stop on the session's own host", async () => {
    h.preview.state = live();
    const e = entry({}, "local");
    mount(data([call(1)], [e]));
    await flush();
    const session = document.querySelector('[data-slot="computer-session"]')!;
    expect(session.textContent).toBe("Untitled in TextEdit");
    expect(session.className).toContain("h-9");
    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(h.stopComputer).toHaveBeenCalledWith(e);
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false));
    h.stopComputer.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    await vi.waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Couldn't stop it", { description: "Untitled in TextEdit" }));
  });

  it("starting: the skeleton in the stream's shape and the running line, before any step", async () => {
    h.preview.state = { status: "starting" };
    mount(data([running(1)], [entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT } })]));
    await flush();
    expect(box()!.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(box()!.style.aspectRatio).toBe("16 / 10");
    expect(runningRows()).toHaveLength(1);
    expect(rows()).toHaveLength(0);
  });

  it("reading says Reading and its app, since the app is all there is", async () => {
    h.preview.state = live();
    mount(data([running(1, { steps: [{ kind: "read", verb: "Reading", object: "", inApp: "TextEdit" }] })], [entry({ running: { tool: "computer_observe", words: "Reading TextEdit", startedAt: AT } })]));
    await flush();
    expect(runningRows()[0].textContent).toBe("ReadingTextEdit");
  });

  it("a batch runs as one line, Working in its app, with its planned steps under it; when it answers, one row per step", async () => {
    h.preview.state = live();
    const plan = ['click button "To"', 'type 6 characters into input "Subject"', "press super+Return"];
    const batch = running(2, {
      app: "Mail",
      plan,
      steps: [step("Clicking", "To", { state: undefined, inApp: "To in Mail" }), step("Typing", "into Subject", { state: undefined, kind: "type", inApp: "into Subject in Mail" }), step("Pressing", "super+Return", { state: undefined, kind: "key", inApp: "super+Return in Mail" })],
    });
    const e = entry({ apps: [{ name: "Mail", bundleId: "com.apple.mail", window: "New Message" }], running: { tool: "computer_batch", words: "Working in Mail", startedAt: AT } });
    const view = mount(data([call(1), batch], [e]));
    await flush();
    expect(runningRows()[0].querySelector(".h-7")!.textContent).toBe("Workingin Mail");
    // one planned step a line: a step's own words hold commas
    const planned = [...runningRows()[0].querySelectorAll('[data-slot="step-plan"] > span')];
    expect(planned.map((s) => s.textContent)).toEqual(plan);
    for (const line of planned) expect(line.className).toContain("block");
    expect(rows()).toHaveLength(1);
    // it answers: three rows, newest first, and no running line
    const done = call(2, {
      app: "Mail",
      steps: [step("Clicked", "To", { inApp: "To in Mail" }), step("Typed", "into Subject", { kind: "type", inApp: "into Subject in Mail" }), step("Pressed", "super+Return", { kind: "key", inApp: "super+Return in Mail" })],
    });
    view.again(data([call(1), done], [entry({ apps: e.row.apps })]));
    await flush();
    expect(runningRows()).toHaveLength(0);
    expect(rows().map(words)).toEqual(["Pressedsuper+Return", "Typedinto Subject", "ClickedTo in Mail", "ClickedStep 1 in TextEdit"]);
    // the steps that landed while following take the house's landing cue, a step apart; the one there at mount does not
    expect(rows().map((r) => [r.classList.contains("step-land"), r.style.getPropertyValue("--stagger")])).toEqual([
      [true, "2"],
      [true, "1"],
      [true, "0"],
      [false, ""],
    ]);
  });

  it("held for the person: the dashed ring, the scheduler's line whole, and under it what waits", async () => {
    h.preview.state = live();
    const waiting = running(1, { steps: [step("Clicking", "Save", { state: undefined, tier: undefined, asked: { verb: "Click", object: "Save", inApp: "Save in TextEdit" } })] });
    mount(data([waiting], [entry({ running: { tool: "computer_act", words: "Waiting for the Mac to be free, 2nd in line", startedAt: AT, held: true }, tier: "session" })]));
    await flush();
    const line = runningRows()[0];
    expect(line.getAttribute("data-state")).toBe("queued");
    expect(line.querySelector('[data-state="queued"]')).toBeTruthy();
    const said = line.querySelector('[data-slot="step-line"] .text-foreground')!;
    expect(said.textContent).toBe("Waiting for the Mac to be free, 2nd in line");
    // said whole: it wraps in a narrow pane, it is never cut
    expect(said.className).not.toContain("truncate");
    expect(line.querySelector('[data-slot="step-line"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-7", "items-start"]));
    // it has not begun: what waits reads as what is asked
    expect(line.querySelector('[data-slot="step-plan"]')!.textContent).toBe("Click Save");
    // the panel never answers the card: no Run now, no Skip
    expect(screen.queryByRole("button", { name: /Run now|Skip|Allow/ })).toBeNull();
  });

  it("waiting on an approval card: the amber mark and the card's question as the line's words", async () => {
    h.preview.state = live();
    mount(data([running(1)], [entry({ asking: { line: "Click Save in TextEdit?" }, running: { tool: "computer_act", words: "Waiting for your approval", startedAt: AT, held: true } })]));
    await flush();
    const line = runningRows()[0];
    expect(line.getAttribute("data-state")).toBe("waiting");
    expect(line.querySelector('[data-state="waiting"]')!.className).toContain("text-warning");
    expect(line.querySelector('[data-slot="step-line"]')!.textContent).toBe("Click Save in TextEdit?");
    expect(line.querySelector('[data-slot="step-line"] .text-foreground')!.className).not.toContain("truncate");
    expect(line.querySelector('[data-slot="step-plan"]')).toBeNull();
  });

  it("a box thread: a card on the Mac and a hold in line read the same from the box's row", () => {
    const boxEntry = (over: Partial<ComputerSessionRow>): ComputerEntry => ({ host: "env_box", row: row({ threadId: "b1", macPeer: "env_mac", macName: "Mac", ...over }), previewable: true, previewHost: "local", previewKey: "mac:env_box:b1" });
    const list = rowsOf([{ key: "mac:env_box:b1", threadId: "b1", calls: [running(1)] }]);
    expect(runningLines([boxEntry({ asking: { line: "Click Save in TextEdit?" }, running: { tool: "computer_act", words: "x", startedAt: 1 } })], list)).toEqual([
      { id: "running:env_box:b1", state: "waiting", verb: "", object: "Click Save in TextEdit?" },
    ]);
    expect(runningLines([boxEntry({ running: { tool: "computer_act", words: "Waiting for the Mac, load 12.3 of 8, 3rd in line", startedAt: 1, held: true } })], list)).toEqual([
      { id: "running:env_box:b1", state: "queued", verb: "", object: "Waiting for the Mac, load 12.3 of 8, 3rd in line", waits: "Clicking Save" },
    ]);
  });

  it("between calls: no running line, the picture stays live, the newest step is open", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2)], [entry()]));
    await flush();
    expect(runningRows()).toHaveLength(0);
    expect(box()!.getAttribute("data-face")).toBe("live");
    expect(words(openRow())).toBe("ClickedStep 2");
  });

  it("the live row's own words stand in until the journal's start lands", () => {
    expect(runningLines([entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: 1 } })], { running: [], groups: [] })).toEqual([
      { id: "running:local:t1", state: "working", verb: "", object: "Clicking Save in TextEdit" },
    ]);
    // and a start with no live row yet is still the running line, naming its app
    expect(runningLines([], rowsOf([{ key: "t1", threadId: "t1", calls: [running(1)] }]))).toEqual([{ id: "running:t1", state: "working", verb: "Clicking", object: "Save in TextEdit" }]);
  });

  it("a call the journal already ended is not drawn as running again from the live row's words, which come a moment later", () => {
    const row = entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT + 1100 } });
    // the journal's call began before the row's call was marked running and has ended: the row's push is on its way
    const ended = rowsOf([{ key: "t1", threadId: "t1", calls: [call(1)] }]);
    expect(runningLines([row], ended)).toEqual([]);
    // a call that began after the journal's newest ended is another call: the row's words stand in for its start
    const later = entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT + 5000 } });
    expect(runningLines([later], ended)).toEqual([{ id: "running:local:t1", state: "working", verb: "", object: "Clicking Save in TextEdit" }]);
  });

  it("a held step that has not begun reads as what is asked under its line, never as under way", () => {
    const held = entry({ running: { tool: "computer_act", words: "Waiting for the Mac to be free, 2nd in line", startedAt: AT, held: true } });
    const start = running(2, { steps: [step("Pressing", "⌘S", { state: undefined, tier: undefined, kind: "key", asked: { verb: "Press", object: "⌘S", inApp: "⌘S in TextEdit" } })] });
    expect(runningLines([held], rowsOf([{ key: "t1", threadId: "t1", calls: [call(1), start] }]))).toEqual([
      { id: "running:local:t1", state: "queued", verb: "", object: "Waiting for the Mac to be free, 2nd in line", waits: "Press ⌘S" },
    ]);
    // a batch that waits is its planned steps, which are what is asked already
    const batch = running(2, { app: "Mail", plan: ["Click To", "Type into Subject"], steps: [step("Clicking", "To", { state: undefined }), step("Typing", "into Subject", { state: undefined })] });
    expect(runningLines([held], rowsOf([{ key: "t1", threadId: "t1", calls: [batch] }]))[0]).toMatchObject({ state: "queued", plan: ["Click To", "Type into Subject"] });
    expect(runningLines([held], rowsOf([{ key: "t1", threadId: "t1", calls: [batch] }]))[0].waits).toBeUndefined();
  });

  it("two live sessions: the followed one's row sits last, next to the box; each has its own Stop, by name, and its own line", async () => {
    h.preview.state = live();
    const lead = entry({ threadId: "sub1", apps: [{ name: "Mail", bundleId: "com.apple.mail", window: "Inbox" }], running: { tool: "computer_act", words: "Clicking Send in Mail", startedAt: AT } });
    const other = entry({ running: { tool: "computer_observe", words: "Reading TextEdit", startedAt: AT } });
    const d: ComputerSectionData = {
      entries: [lead, other],
      keys: [
        { key: "t1", threadId: "t1" },
        { key: "sub1", threadId: "sub1" },
      ],
      histories: {
        t1: { born: 1, calls: [call(1), running(2, { steps: [{ kind: "read", verb: "Reading", object: "", inApp: "TextEdit" }] })], more: false, status: "ready" },
        sub1: { born: 2, calls: [running(1, { app: "Mail", steps: [step("Clicking", "Send", { state: undefined, inApp: "Send in Mail" })] })], more: false, status: "ready" },
      },
      exists: true,
      live: true,
    };
    mount(d);
    await flush();
    // the session the viewport follows is the row right above the box, so the picture is never read as another's
    const sessionRows = [...document.querySelectorAll<HTMLElement>('[data-slot="computer-session"]')];
    expect(sessionRows.map((s) => s.textContent)).toEqual(["Untitled in TextEdit", "Inbox in Mail"]);
    expect(sessionRows[1].nextElementSibling).toBe(document.querySelector('[data-slot="computer-viewport"]'));
    expect(h.preview.entries.at(-1)).toBe(lead);
    expect(box()!.getAttribute("aria-label")).toBe("Live view of Inbox in Mail");
    // each Stop says whose it is
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Inbox in Mail" })).toBeTruthy();
    // with several, each running line names its app
    expect(runningRows().map((r) => r.textContent)).toEqual(["ClickingSend in Mail", "ReadingTextEdit"]);
    fireEvent.click(screen.getByRole("button", { name: "Stop Untitled in TextEdit" }));
    expect(h.stopComputer).toHaveBeenCalledWith(other);
    // Go live belongs to the followed session's row
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(document.querySelectorAll('[data-slot="computer-session"]')[1].querySelector('[data-slot="go-live"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="computer-session"]')[0].querySelector('[data-slot="go-live"]')).toBeNull();
  });
});

// ── pinning ──

describe("pinning", () => {
  it("a click on a finished row pins it: its call's picture, the stream stopped, Go live shown; Go live follows again", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2), call(3)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(words(openRow())).toBe("ClickedStep 1 in TextEdit");
    // the picture as it was: a button named for the window and the time, not the stream
    expect(box()!.tagName).toBe("BUTTON");
    expect(box()!.getAttribute("aria-label")).toBe(`Untitled in TextEdit at ${clockTime(AT + 1400)}`);
    expect(box()!.querySelector("img")!.getAttribute("src")).toMatch(/^blob:/);
    expect(h.readStep).toHaveBeenCalledWith("t1", 1);
    // the stream stops: the Mac stops capturing for it
    expect(h.preview.runs.at(-1)).toBe(false);
    expect(document.querySelector('[data-slot="computer-section"]')!.hasAttribute("data-following")).toBe(false);
    const goLive = screen.getByRole("button", { name: "Go live" });
    fireEvent.click(goLive);
    await flush();
    expect(box()!.getAttribute("data-face")).toBe("live");
    expect(h.preview.runs.at(-1)).toBe(true);
    expect(words(openRow())).toBe("ClickedStep 3");
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  });

  it("choosing a row also fetches the pictures of the rows either side of it", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2), call(3), call(4)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:2:0"));
    await flush();
    expect(h.readStep.mock.calls.map((c) => c[1]).sort()).toEqual([1, 2, 3]);
  });

  it("while pinned the running line is a way back to the live window", async () => {
    h.preview.state = live();
    mount(data([call(1), running(2)], [entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT } })]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    const back = screen.getByRole("button", { name: "Follow the live window: Clicking Save" });
    fireEvent.click(back);
    await flush();
    expect(box()!.getAttribute("data-face")).toBe("live");
  });

  it("↓ is older, ↑ newer, End the oldest loaded, Home the live end; the list has one tab stop", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2), call(3)], [entry()]));
    await flush();
    const tabStops = (): string[] => [...stepList().querySelectorAll<HTMLButtonElement>("button[data-row]")].filter((b) => b.tabIndex === 0).map((b) => b.dataset.row!);
    expect(tabStops()).toEqual(["t1:3:0"]);
    fireEvent.keyDown(rowButton("t1:3:0"), { key: "ArrowDown" });
    await flush();
    expect(words(openRow())).toBe("ClickedStep 2");
    expect(tabStops()).toEqual(["t1:2:0"]);
    expect(screen.getByRole("button", { name: "Go live" })).toBeTruthy();
    fireEvent.keyDown(rowButton("t1:2:0"), { key: "End" });
    await flush();
    expect(words(openRow())).toBe("ClickedStep 1 in TextEdit");
    fireEvent.keyDown(rowButton("t1:1:0"), { key: "ArrowDown" });
    await flush();
    expect(words(openRow())).toBe("ClickedStep 1 in TextEdit");
    fireEvent.keyDown(rowButton("t1:1:0"), { key: "ArrowUp" });
    await flush();
    expect(words(openRow())).toBe("ClickedStep 2");
    fireEvent.keyDown(rowButton("t1:2:0"), { key: "Home" });
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    expect(box()!.getAttribute("data-face")).toBe("live");
    // ↑ from the newest row is the live end too
    fireEvent.keyDown(rowButton("t1:3:0"), { key: "ArrowDown" });
    await flush();
    fireEvent.keyDown(rowButton("t1:2:0"), { key: "ArrowUp" });
    await flush();
    expect(words(openRow())).toBe("ClickedStep 3");
    fireEvent.keyDown(rowButton("t1:3:0"), { key: "ArrowUp" });
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    // a modified key is not the list's
    fireEvent.keyDown(rowButton("t1:3:0"), { key: "ArrowDown", metaKey: true });
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  });

  it("the pinned row keeps its place as rows land above it: the list scrolls on by their height, from 0 too, and they do not animate", async () => {
    h.preview.state = live();
    // each row is 28px tall in this layout; the scroller's own offset is 0
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const all = [...document.querySelectorAll('[data-slot="step"]')];
        return Math.max(0, all.indexOf(this)) * 28;
      },
    });
    const view = mount(data([call(1), call(2)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:2:0"));
    await flush();
    expect(stepList().scrollTop).toBe(0);
    view.again(data([call(1), call(2), call(3), call(4)], [entry()]));
    await flush();
    // two rows landed above the pinned one: 56px on
    expect(stepList().scrollTop).toBe(56);
    expect(words(openRow())).toBe("ClickedStep 2");
    expect(rows().some((r) => r.classList.contains("step-land"))).toBe(false);
    view.again(data([call(1), call(2), call(3), call(4), call(5)], [entry()]));
    await flush();
    expect(stepList().scrollTop).toBe(84);
    // following again: back at the live end, and what lands now does animate
    fireEvent.click(screen.getByRole("button", { name: "Go live" }));
    await flush();
    expect(stepList().scrollTop).toBe(0);
    view.again(data([call(1), call(2), call(3), call(4), call(5), call(6)], [entry()]));
    await flush();
    expect(rows().filter((r) => r.classList.contains("step-land")).map(words)).toEqual(["ClickedStep 6"]);
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
  });

  it("the box keeps the height it had when the pin began, and follows the picture again when the selection follows", async () => {
    h.preview.state = live();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 185, width: 296, top: 0, left: 0, right: 296, bottom: 185, x: 0, y: 0, toJSON: () => ({}) });
    mount(data([call(1, { picture: { width: 930, height: 1280, at: 1 } }), call(2)], [entry()]));
    await flush();
    expect(box()!.style.height).toBe("");
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    // a tall picture sits inside the kept height, centred
    expect(box()!.style.height).toBe("185px");
    expect(box()!.style.aspectRatio).toBe("");
    fireEvent.keyDown(rowButton("t1:1:0"), { key: "ArrowUp" });
    await flush();
    expect(box()!.style.height).toBe("185px");
    fireEvent.click(screen.getByRole("button", { name: "Go live" }));
    await flush();
    expect(box()!.style.height).toBe("");
    expect(box()!.style.aspectRatio).toBe("960 / 600");
    rect.mockRestore();
  });

  it("choosing another row while one is pinned moves nothing: the offset kept is the pinned row's own", async () => {
    h.preview.state = live();
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const all = [...document.querySelectorAll('[data-slot="step"]')];
        return Math.max(0, all.indexOf(this)) * 28;
      },
    });
    mount(data([call(1), call(2), call(3)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:3:0"));
    await flush();
    expect(stepList().scrollTop).toBe(0);
    // a lower row, 56px down: the list stays where the person has it
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(stepList().scrollTop).toBe(0);
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
  });

  it("a pinned step that kept nothing keeps the box's place, with its line inside: stepping through rows moves nothing", async () => {
    h.preview.state = live();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 185, width: 296, top: 0, left: 0, right: 296, bottom: 185, x: 0, y: 0, toJSON: () => ({}) });
    mount(data([call(1, { picture: { none: "gone" } }), call(2, { picture: { none: "off" } }), call(3)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:3:0"));
    await flush();
    expect(box()!.style.height).toBe("185px");
    fireEvent.keyDown(rowButton("t1:3:0"), { key: "ArrowDown" });
    await flush();
    expect(box()!.getAttribute("data-face")).toBe("none");
    expect(box()!.style.height).toBe("185px");
    expect(box()!.textContent).toBe("No picture was kept");
    fireEvent.keyDown(rowButton("t1:2:0"), { key: "ArrowDown" });
    await flush();
    expect(box()!.getAttribute("data-face")).toBe("none");
    expect(box()!.textContent).toBe("This picture is no longer kept");
    rect.mockRestore();
  });

  it("the fade is the viewport's arrival alone: its wrapper carries it and stays through every change of face", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2)], [entry()]));
    await flush();
    const wrapper = document.querySelector<HTMLElement>('[data-slot="computer-viewport"]')!;
    expect(wrapper.className).toContain("starting:opacity-0");
    expect(box()!.className).not.toContain("starting:opacity-0");
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(box()!.tagName).toBe("BUTTON");
    expect(box()!.className).not.toContain("starting:opacity-0");
    // the same wrapper: nothing was mounted again, so nothing fades again
    expect(document.querySelector('[data-slot="computer-viewport"]')).toBe(wrapper);
    fireEvent.click(screen.getByRole("button", { name: "Go live" }));
    await flush();
    expect(document.querySelector('[data-slot="computer-viewport"]')).toBe(wrapper);
  });

  it("a picture read that fails says so, with Retry: it is never No picture was kept, and Retry reads again", async () => {
    h.preview.state = live();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 185, width: 296, top: 0, left: 0, right: 296, bottom: 185, x: 0, y: 0, toJSON: () => ({}) });
    let fail = true;
    h.readStep.mockImplementation(async (_k: string, n: number) => {
      if (fail) throw new Error("the socket dropped");
      return picture(n);
    });
    mount(data([call(1), call(2)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    // the box keeps its place, and says what went wrong
    expect(box()!.getAttribute("data-face")).toBe("none");
    expect(box()!.textContent).toBe("Couldn't read the pictureRetry");
    expect(box()!.textContent).not.toContain("No picture was kept");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(box()!.tagName).toBe("BUTTON");
    expect(box()!.querySelector("img")).toBeTruthy();
    // the pin held through the failure and the retry
    expect(openRow()!.getAttribute("data-step")).toBe("t1:1:0");
    rect.mockRestore();
  });

  it("while a pinned picture is on its way, the picture still shown keeps its own name", async () => {
    const reads = deferredReads();
    mount(data([call(1, { window: "First" }), call(2, { window: "Second" })]));
    await flush();
    await reads.answer(2);
    const second = `Second in TextEdit at ${clockTime(AT + 2450)}`;
    expect(box()!.getAttribute("aria-label")).toBe(second);
    const shown = box()!.querySelector("img")!.getAttribute("src");
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    // call 1's picture has not answered: what is on screen is still call 2's, and it says so
    expect(box()!.querySelector("img")!.getAttribute("src")).toBe(shown);
    expect(box()!.getAttribute("aria-label")).toBe(second);
    await reads.answer(1);
    expect(box()!.querySelector("img")!.getAttribute("src")).not.toBe(shown);
    expect(box()!.getAttribute("aria-label")).toBe(`First in TextEdit at ${clockTime(AT + 1450)}`);
  });

  it("a kept picture opens the lightbox from the box, and the live box does not", async () => {
    h.preview.state = live();
    mount(data([call(1), call(2)], [entry()]));
    await flush();
    fireEvent.click(box()!);
    expect(h.openLightbox).not.toHaveBeenCalled();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    fireEvent.click(box()!);
    expect(h.openLightbox).toHaveBeenCalledTimes(1);
    const [items, index] = h.openLightbox.mock.calls[0];
    expect(items).toEqual([{ environmentId: "local", name: `Untitled in TextEdit at ${clockTime(AT + 1400)}`, src: expect.stringMatching(/^blob:/) }]);
    expect(index).toBe(0);
  });

  it("picture A answering after picture B is dropped", async () => {
    h.preview.state = live();
    const reads = deferredReads();
    mount(data([call(1), call(2), call(3), call(4), call(5)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    fireEvent.click(rowButton("t1:4:0"));
    await flush();
    // B lands first, then the late A
    await reads.answer(4);
    const shown = box()!.querySelector("img")!.getAttribute("src");
    expect(shown).toMatch(/^blob:/);
    await reads.answer(1);
    expect(box()!.querySelector("img")!.getAttribute("src")).toBe(shown);
    expect(box()!.getAttribute("aria-label")).toBe(`Untitled in TextEdit at ${clockTime(AT + 4400)}`);
  });

  it("a first picture on its way is a skeleton; the next dims the old one only once it has taken more than 150 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.preview.state = live();
    const reads = deferredReads();
    mount(data([call(1), call(2), call(3)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    // nothing shown yet: a skeleton in the picture's shape
    expect(box()!.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(box()!.querySelector("img")).toBeNull();
    await reads.answer(1);
    const first = box()!.querySelector("img")!.getAttribute("src");
    // the next picture: the old one stays, undimmed for the first 150 ms
    fireEvent.keyDown(rowButton("t1:1:0"), { key: "ArrowUp" });
    await flush();
    expect(box()!.querySelector("img")!.getAttribute("src")).toBe(first);
    expect(box()!.querySelector("img")!.className).not.toContain("opacity-40");
    await act(async () => vi.advanceTimersByTime(PICTURE_DIM_MS - 1));
    expect(box()!.querySelector("img")!.className).not.toContain("opacity-40");
    await act(async () => vi.advanceTimersByTime(1));
    expect(box()!.querySelector("img")!.className).toContain("opacity-40");
    // it lands: the new picture, undimmed, with no transition of its own beyond the dim's
    await reads.answer(2);
    expect(box()!.querySelector("img")!.getAttribute("src")).not.toBe(first);
    expect(box()!.querySelector("img")!.className).not.toContain("opacity-40");
  });

  it("a pinned step of a batch that is not its last shows the call's picture and says After all 3 steps", async () => {
    h.preview.state = live();
    const batch = call(2, { steps: [step("Clicked", "To"), step("Typed", "into Subject", { kind: "type" }), step("Pressed", "super+Return", { kind: "key" })] });
    mount(data([call(1), batch], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:2:0"));
    await flush();
    expect(lineUnder()).toBe("After all 3 steps");
    // its last step is the picture's own: with a session live, the line says only that this is not the window now
    fireEvent.click(rowButton("t1:2:2"));
    await flush();
    expect(lineUnder()).toBe("As it was after this step");
    // one call, one read: the rows of one call share it
    expect(h.readStep.mock.calls.filter((c) => c[1] === 2)).toHaveLength(1);
  });

  it("a batch that stopped part way says After the steps that ran: the picture is not of steps that never ran", async () => {
    h.preview.state = live();
    const batch = call(2, { steps: [step("Clicked", "To"), step("Type", "into Subject", { kind: "type", state: "failed", tier: undefined, reason: "The element was gone" }), step("Press", "super+Return", { kind: "key", state: "not-run", tier: undefined })] });
    mount(data([call(1), batch], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:2:0"));
    await flush();
    expect(lineUnder()).toBe("After the steps that ran");
  });

  it("a pinned picture with nothing live needs no line: its row says its time", async () => {
    mount(data([call(1), call(2)]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(box()!.tagName).toBe("BUTTON");
    expect(lineUnder()).toBe("");
  });

  it("a pinned step with no picture shows the read text in the box's place and says why; with no reason to give, that it is not the window now", async () => {
    h.preview.state = live();
    h.readStep.mockImplementation(async () => ({ text: 'app "TextEdit" · window "Untitled" · 1280×1072\n[1] window "Untitled"' }));
    const cases: [ComputerHistoryCall["picture"], string][] = [
      [{ none: "permission" }, "Screen Recording was off"],
      [{ none: "minimized" }, "The window was minimized"],
      [{ none: "not-drawn" }, "The window was not drawn"],
      [{ none: "gone" }, "This picture is no longer kept"],
      [{ none: "off" }, "As it was after this step"],
      [{ none: "failed" }, "As it was after this step"],
    ];
    for (const [none, said] of cases) {
      mount(data([call(1, { picture: none, text: true, read: "Read 1 element" }), call(2)], [entry()]));
      await flush();
      fireEvent.click(rowButton("t1:1:0"));
      await flush();
      expect(box()!.tagName, said).toBe("PRE");
      expect(box()!.textContent).toContain('[1] window "Untitled"');
      expect(lineUnder(), JSON.stringify(none)).toBe(said);
      cleanup();
    }
  });

  it("a step whose picture is no longer kept and that read nothing is its line alone", async () => {
    h.preview.state = live();
    mount(data([call(1, { picture: { none: "gone" } }), call(2)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(box()).toBeNull();
    expect(lineUnder()).toBe("This picture is no longer kept");
    // nothing was kept for it, so nothing is asked for it (its neighbour's picture is)
    expect(h.readStep.mock.calls.map((c) => c[1])).not.toContain(1);
  });
});

// ── the row states ──

describe("the row states", () => {
  const openOn = async (c: ComputerHistoryCall, id = "t1:1:0"): Promise<HTMLElement> => {
    mount(data([c]));
    await flush();
    if (openRow()?.getAttribute("data-step") !== id) {
      fireEvent.click(rowButton(id));
      await flush();
    }
    return openRow()!;
  };

  it("a failed step: the red mark, a red line that says why, and the batch's later steps muted, Not run", async () => {
    const batch = call(1, {
      steps: [step("Clicked", "To"), step("Type", "into Subject", { kind: "type", state: "failed", tier: undefined, reason: "The element was gone" }), step("Press", "super+Return", { kind: "key", state: "not-run", tier: undefined })],
    });
    const failed = await openOn(batch, "t1:1:1");
    expect(failed.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("failed");
    expect(failed.querySelector('[data-state="failed"]')!.className).toContain("text-destructive");
    const why = failed.querySelector('[data-slot="step-why"]')!;
    expect(why.textContent).toBe("The element was gone");
    expect(why.className).toContain("text-destructive");
    // the step that did not run is muted whole, a dash in its glyph's place
    const notRun = rows()[0];
    expect(words(notRun)).toBe("Presssuper+Return");
    expect(notRun.querySelector(".text-foreground")).toBeNull();
    expect(notRun.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("not-run");
    expect(rows()[2].querySelector('[data-slot="step-glyph"]')!.hasAttribute("data-mark")).toBe(false);
    fireEvent.click(rowButton("t1:1:2"));
    await flush();
    expect(openRow()!.querySelector('[data-slot="step-why"]')!.textContent).toBe("Not run");
    expect(openRow()!.querySelector('[data-slot="step-why"]')!.className).toContain("text-muted-foreground");
  });

  it("following a batch that failed part way opens the step that failed, not the tail that never ran; the closing read is the failed step's", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-step") ?? "");
    };
    const batch = call(2, {
      read: "Read 3 changes",
      steps: [
        step("Clicked", "To"),
        step("Type", "into Subject", { kind: "type", state: "failed", tier: undefined, reason: "The element was gone" }),
        step("Press", "⌘Return", { kind: "key", state: "not-run", tier: undefined }),
        step("Press", "Tab", { kind: "key", state: "not-run", tier: undefined }),
      ],
    });
    mount(data([call(1), batch]));
    await flush();
    // nothing was chosen by hand: the section follows, and what it opens is the failure
    expect(document.querySelector('[data-slot="computer-section"]')!.hasAttribute("data-following")).toBe(true);
    expect(openRow()!.getAttribute("data-step")).toBe("t1:2:1");
    expect(openRow()!.querySelector('[data-slot="step-why"]')!.textContent).toBe("The element was gone");
    // it is brought into view under the rows that never ran
    expect(scrolled).toEqual(["t1:2:1"]);
    // the read came after the step that was tried last, never after one that did not run
    expect(openRow()!.querySelector('[data-slot="step-read"]')!.textContent).toBe("Read 3 changes");
    fireEvent.click(rowButton("t1:2:3"));
    await flush();
    expect(openRow()!.querySelector('[data-slot="step-read"]')).toBeNull();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("a row's name says how its step ended, since its mark is drawn and not said", async () => {
    const batch = call(1, {
      steps: [step("Clicked", "To"), step("Type", "into Subject", { kind: "type", state: "failed", tier: undefined, reason: "The element was gone" }), step("Press", "⌘Return", { kind: "key", state: "not-run", tier: undefined })],
    });
    mount(data([batch, call(2, { steps: [step("Click", "Save", { state: "stopped", tier: undefined, reason: "Stopped" })] }), call(3, { state: "unfinished", endedAt: undefined, picture: undefined, rev: 1, steps: [step("Press", "⌘S", { state: undefined })] })]));
    await flush();
    const names = (id: string): string | null => rowButton(id).getAttribute("aria-label");
    expect(names("t1:3:0")).toBe("Press ⌘S, didn't finish");
    expect(names("t1:2:0")).toBe("Click Save, stopped");
    expect(names("t1:1:2")).toBe("Press ⌘Return, not run");
    expect(names("t1:1:1")).toBe("Type into Subject, failed");
    // a step that ran is its words alone
    expect(names("t1:1:0")).toBeNull();
  });

  it("stopped by the person's touch, and stopped by Stop: the square and the reason, said plainly", async () => {
    const touch = await openOn(call(1, { steps: [step("Clicked", "Save", { state: "stopped", tier: undefined, reason: "Stopped when you used the mouse or keyboard" })] }));
    expect(touch.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("stopped");
    expect(touch.querySelector('[data-state="stopped"]')).toBeTruthy();
    expect(touch.querySelector('[data-slot="step-why"]')!.textContent).toBe("Stopped when you used the mouse or keyboard");
    // a stop is not a failure: no red
    expect(touch.querySelector('[data-slot="step-why"]')!.className).not.toContain("text-destructive");
    cleanup();
    const stop = await openOn(call(1, { steps: [step("Clicked", "Save", { state: "stopped", tier: undefined, reason: "Stopped" })] }));
    expect(stop.querySelector('[data-slot="step-why"]')!.textContent).toBe("Stopped");
  });

  it("didn't finish: a start with no end that is not the running call is one row for the whole call", async () => {
    const lost = call(1, { state: "unfinished", endedAt: undefined, picture: undefined, rev: 1, steps: [step("Click", "To", { state: undefined }), step("Type", "into Subject", { state: undefined })] });
    const el = await openOn(lost);
    expect(rows()).toHaveLength(1);
    // what was asked, never "Worked": it did not finish
    expect(words(el)).toBe("Workin TextEdit");
    expect(el.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("stopped");
    expect(el.querySelector('[data-slot="step-why"]')!.textContent).toBe("Didn't finish");
    expect(runningRows()).toHaveLength(0);
  });

  it("refused before it ran: what was asked, with the refusal's line; the person's own no is a stop, the host's a failure", async () => {
    const no = await openOn(call(1, { picture: { none: "no-read" }, steps: [step("Click", "Save", { state: "stopped", tier: undefined, reason: "You didn't allow it" })] }));
    expect(words(no)).toBe("ClickSave in TextEdit");
    expect(no.querySelector('[data-slot="step-why"]')!.textContent).toBe("You didn't allow it");
    expect(no.querySelector('[data-slot="step-why"]')!.className).not.toContain("text-destructive");
    expect(no.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("stopped");
    cleanup();
    const off = await openOn(call(1, { picture: { none: "no-read" }, steps: [step("Click", "Save", { state: "failed", tier: undefined, reason: "Computer use was off" })] }));
    expect(off.querySelector('[data-slot="step-why"]')!.className).toContain("text-destructive");
    expect(off.querySelector('[data-slot="step-glyph"]')!.getAttribute("data-mark")).toBe("failed");
  });

  it("the facts line: the tier first, what it acted on, how it went, then its time; nothing for the plain case", async () => {
    const el = await openOn(
      call(1, {
        steps: [step("Pressed", "super+s", { kind: "key", tier: "front", facts: ["saved ~/run/Total.txt", "through the menu File › Save…", "still changing after 1.5 s"] })],
      }),
    );
    expect([...el.querySelectorAll('[data-slot="facts"] > span')].map((s) => s.textContent)).toEqual(["in front", "saved ~/run/Total.txt", "through the menu File › Save…", "still changing after 1.5 s", clockTime(AT + 1400)]);
    expect(el.textContent).not.toMatch(/\b(ax|process|session)\b/);
    cleanup();
    // a read has no tier: its time alone, and what it took in
    const read = await openOn(call(1, { read: "Read no changes", steps: [{ kind: "read", verb: "Read", object: "", inApp: "TextEdit", state: "ok" }] }));
    expect([...read.querySelectorAll('[data-slot="facts"] > span')].map((s) => s.textContent)).toEqual([clockTime(AT + 1400)]);
    // its own row already says Read: the line is what it took in alone
    expect(read.querySelector('[data-slot="step-read"]')!.textContent).toBe("No changes");
    // a read that is its header alone is no disclosure
    expect(read.querySelector('[data-slot="step-read"]')!.tagName).toBe("SPAN");
  });

  it("a password typed says its length only: the words are the host's", async () => {
    const el = await openOn(call(1, { steps: [step("Typed", "into Password", { kind: "type", target: "20 characters" })] }));
    expect([...el.querySelectorAll('[data-slot="facts"] > span')].map((s) => s.textContent)).toEqual(["in the background", "20 characters", clockTime(AT + 1400)]);
  });

  it("a thin tree reads Looked at the picture", async () => {
    const el = await openOn(call(1, { read: "Looked at the picture", steps: [{ kind: "read", verb: "Read", object: "", inApp: "Canvas Demo", state: "ok" }], app: "Canvas Demo" }));
    expect(el.querySelector('[data-slot="step-read"]')!.textContent).toBe("Looked at the picture");
  });

  it("each kind has its glyph, uncoloured", async () => {
    const kinds = ["click", "type", "key", "scroll", "read", "look", "wait", "app"] as const;
    mount(data(kinds.map((kind, i) => call(i + 1, { steps: [step("Did", kind, { kind })] }))));
    await flush();
    const glyphs = rows().map((r) => r.querySelector('[data-slot="step-glyph"] svg')!);
    expect(glyphs).toHaveLength(8);
    expect(new Set(glyphs.map((g) => g.innerHTML)).size).toBe(8);
    for (const r of rows()) expect(r.querySelector('[data-slot="step-glyph"]')!.className).toContain("text-muted-foreground");
  });
});

// ── the read line ──

describe("the read line", () => {
  const TEXT = ['app "TextEdit" · window "Untitled" · 1280×1072 · changes since your last read', '~ [3] text area = "Hello"', "+ in [1]:", '  [44] button "Save"', '  [45] button "Cancel"'].join("\n");

  it("fetches when it opens, marks the lines of the element the step acted on, and closes when the open row changes", async () => {
    h.readStep.mockImplementation(async (_k: string, n: number) => (n === 2 ? { ...picture(2), text: TEXT } : picture(n)));
    mount(data([call(1), call(2, { text: true, read: "Read 3 changes", steps: [step("Clicked", "Save", { element: 44 })] })]));
    await flush();
    const before = h.readStep.mock.calls.length;
    const toggle = openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.textContent).toBe("Read 3 changes");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector("svg")!.getAttribute("class")).not.toContain("rotate-90");
    await act(async () => fireEvent.click(toggle));
    await flush();
    expect(openRow()!.querySelector('[data-slot="step-read"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(openRow()!.querySelector('[data-slot="step-read"] svg')!.getAttribute("class")).toContain("rotate-90");
    const pre = openRow()!.querySelector<HTMLElement>('[data-slot="step-read-text"]')!;
    expect(pre.tabIndex).toBe(0);
    expect(pre.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-h-60", "overflow-x-auto", "overflow-y-auto", "whitespace-pre"]));
    expect(pre.textContent).toContain('[45] button "Cancel"');
    const acted = [...pre.querySelectorAll("[data-acted]")];
    expect(acted.map((l) => l.textContent)).toEqual(['  [44] button "Save"']);
    expect(acted[0].className).toContain("text-foreground");
    // the picture and the text come in one read of the call
    expect(h.readStep.mock.calls.length - before).toBeLessThanOrEqual(1);
    // the open row changes: the fold is closed on the next row and on the way back
    fireEvent.keyDown(rowButton("t1:2:0"), { key: "ArrowDown" });
    await flush();
    expect(document.querySelector('[data-slot="step-read-text"]')).toBeNull();
    fireEvent.keyDown(rowButton("t1:1:0"), { key: "ArrowUp" });
    await flush();
    expect(openRow()!.querySelector('[data-slot="step-read"]')!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows skeleton lines in the console's place while the text is on its way", async () => {
    const reads = deferredReads();
    h.preview.state = live();
    mount(data([call(1, { text: true, read: "Read 46 elements" })], [entry()]));
    await flush();
    await act(async () => fireEvent.click(openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!));
    expect(screen.getByRole("status", { name: "Loading what was read" })).toBeTruthy();
    await reads.answer(1, { ...picture(1), text: "the read" });
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
  });

  it("opening the read pins its row, so the text stays while more steps land", async () => {
    h.preview.state = live();
    h.readStep.mockImplementation(async (_k: string, n: number) => ({ ...picture(n), text: `read ${n}` }));
    const view = mount(data([call(1), call(2, { text: true, read: "Read 3 changes" })], [entry()]));
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    await act(async () => fireEvent.click(openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!));
    await flush();
    // pinned: Go live shows, the stream stops, the box is that call's picture
    expect(screen.getByRole("button", { name: "Go live" })).toBeTruthy();
    expect(h.preview.runs.at(-1)).toBe(false);
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("read 2");
    view.again(data([call(1), call(2, { text: true, read: "Read 3 changes" }), call(3)], [entry()]));
    await flush();
    expect(words(openRow())).toBe("ClickedStep 2");
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("read 2");
  });

  it("the open text stays while a later record of its call is read again", async () => {
    const reads = deferredReads();
    const held = call(1, { text: true, read: "Read 3 changes", rev: 3 });
    const view = mount(data([held]));
    await flush();
    await reads.answer(1, { ...picture(1), text: "the read" });
    await act(async () => fireEvent.click(openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!));
    await flush();
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
    // a record lands on the call: it is read again, and the text held stays up meanwhile, never a skeleton
    view.again(data([{ ...held, rev: 4 }]));
    await flush();
    expect(reads.asked()).toEqual([1]);
    expect(screen.queryByRole("status", { name: "Loading what was read" })).toBeNull();
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
    await reads.answer(1, { ...picture(1), text: "the read, again" });
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read, again");
  });

  it("a read text that cannot be read says so in the console's place, with Retry", async () => {
    let fail = false;
    h.readStep.mockImplementation(async (_k: string, n: number) => {
      if (fail) throw new Error("the socket dropped");
      return { ...picture(n), text: "the read" };
    });
    const view = mount(data([call(1, { text: true, read: "Read 3 changes", rev: 3 })]));
    await flush();
    await act(async () => fireEvent.click(openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!));
    await flush();
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
    // a later record of the call is read again, and that read fails: the text held stays up
    fail = true;
    view.again(data([call(1, { text: true, read: "Read 3 changes", rev: 4 })]));
    await flush();
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
    cleanup();
    // nothing held: the failure is said where the text would be
    mount(data([call(1, { text: true, read: "Read 3 changes", rev: 3 })]));
    await flush();
    // the viewport's own read failed too
    expect(lineUnder()).toBe("Couldn't read the pictureRetry");
    await act(async () => fireEvent.click(openRow()!.querySelector<HTMLButtonElement>('[data-slot="step-read"]')!));
    await flush();
    const failed = document.querySelector('[data-slot="step-read-failed"]')!;
    expect(failed.textContent).toBe("Couldn't read the textRetry");
    expect(document.querySelector('[data-slot="step-read-text"]')).toBeNull();
    fail = false;
    fireEvent.click(failed.querySelector("button")!);
    await flush();
    expect(document.querySelector('[data-slot="step-read-text"]')!.textContent).toBe("the read");
  });

  it("where the viewport already shows the read text, the row's read line says what was read and opens nothing", async () => {
    h.readStep.mockImplementation(async () => ({ text: 'app "TextEdit"\n[1] window "Untitled"' }));
    mount(data([call(1, { picture: { none: "permission" }, text: true, read: "Read 1 element" })]));
    await flush();
    expect(box()!.tagName).toBe("PRE");
    const line = openRow()!.querySelector('[data-slot="step-read"]')!;
    expect(line.tagName).toBe("SPAN");
    expect(line.textContent).toBe("Read 1 element");
    expect(document.querySelector('[data-slot="step-read-text"]')).toBeNull();
  });
});

// ── nothing live ──

describe("once the turn settled", () => {
  it("done: no session row, the newest step open, its picture as it was", async () => {
    mount(data([call(1), call(2)]));
    await flush();
    expect(document.querySelector('[data-slot="computer-session"]')).toBeNull();
    expect(words(openRow())).toBe("ClickedStep 2");
    expect(box()!.tagName).toBe("BUTTON");
    // the picture's own time: it is taken after the call's answer
    expect(box()!.getAttribute("aria-label")).toBe(`Untitled in TextEdit at ${clockTime(AT + 2450)}`);
    expect(lineUnder()).toBe("");
    expect(h.readStep).toHaveBeenCalledWith("t1", 2);
    // nothing is live, so nothing is asked of the Mac
    expect(h.preview.runs.every((run) => run === false)).toBe(true);
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("history only: two turns and a subagent's group, a heading where two groups meet", async () => {
    const d: ComputerSectionData = {
      entries: [],
      keys: [
        { key: "t1", threadId: "t1" },
        { key: "sub1", threadId: "sub1" },
      ],
      histories: {
        t1: { born: 1, calls: [call(1, { turn: 1 }), call(2, { turn: 2, at: AT + 600_000, endedAt: AT + 600_400 }), call(3, { turn: 2, at: AT + 601_000, endedAt: AT + 601_400, app: "Mail", steps: [step("Clicked", "Send", { inApp: "Send in Mail" })] })], more: false, status: "ready" },
        sub1: { born: 2, calls: [call(1, { at: AT + 300_000, endedAt: AT + 300_400 })], more: false, status: "ready" },
      },
      exists: true,
      live: false,
    };
    mount(d);
    await flush();
    const groups = [...document.querySelectorAll('[data-slot="step-group"]')];
    expect(groups.map((g) => g.querySelector('[data-slot="step-heading"]')?.textContent ?? null)).toEqual([null, `Fill in the form${clockTime(AT + 300_000)}`, clockTime(AT + 1000)]);
    expect(groups.map((g) => g.className)).toEqual(["", "mt-4", "mt-4"]);
    expect(groups[1].querySelector('[data-slot="step-heading"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-xs", "font-medium", "text-muted-foreground"]));
    // apps are named only where they change, and by the oldest row of each group
    expect(rows().map(words)).toEqual(["ClickedSend in Mail", "ClickedStep 2 in TextEdit", "ClickedStep 1 in TextEdit", "ClickedStep 1 in TextEdit"]);
  });

  it("where the newest step kept nothing, the newest picture that was kept stands in, and says when it was", async () => {
    // a call stopped in flight keeps no picture and no text; the one before it kept the window
    const stopped = call(2, { picture: { none: "failed" }, steps: [step("Click", "Save", { state: "stopped", tier: undefined, reason: "Stopped" })] });
    mount(data([call(1), stopped]));
    await flush();
    expect(words(openRow())).toBe("ClickSave");
    expect(box()!.tagName).toBe("BUTTON");
    expect(box()!.getAttribute("aria-label")).toBe(`Untitled in TextEdit at ${clockTime(AT + 1450)}`);
    expect(lineUnder()).toBe(`As it was at ${clockTime(AT + 1450)}`);
    expect(h.readStep).toHaveBeenCalledWith("t1", 1);
    cleanup();
    // with nothing kept anywhere there is no box at all
    mount(data([stopped]));
    await flush();
    expect(box()).toBeNull();
  });

  it("the stand-in is the open step's own session's picture first; another window's says whose it is", async () => {
    const d: ComputerSectionData = {
      entries: [],
      keys: [
        { key: "t1", threadId: "t1" },
        { key: "sub1", threadId: "sub1" },
      ],
      histories: {
        // the thread's own newest step kept nothing; its older one did
        t1: { born: 1, calls: [call(1), call(3, { picture: { none: "no-read" }, steps: [step("Click", "Save", { state: "stopped", tier: undefined, reason: "Stopped" })] })], more: false, status: "ready" },
        // a subagent's step is newer than the thread's kept picture
        sub1: { born: 2, calls: [call(2, { app: "Mail", window: "Inbox" })], more: false, status: "ready" },
      },
      exists: true,
      live: false,
    };
    const view = mount(d);
    await flush();
    expect(words(openRow())).toContain("ClickSave");
    expect(box()!.getAttribute("aria-label")).toMatch(/^Untitled in TextEdit at /);
    expect(lineUnder()).toBe(`As it was at ${clockTime(AT + 1450)}`);
    expect(h.readStep).toHaveBeenCalledWith("t1", 1);
    // with nothing kept in its own session, another window's picture stands in and is named
    view.again({ ...d, histories: { ...d.histories, t1: { born: 1, calls: [call(3, { picture: { none: "no-read" }, steps: [step("Click", "Save", { state: "stopped", tier: undefined, reason: "Stopped" })] })], more: false, status: "ready" } } });
    await flush();
    expect(box()!.getAttribute("aria-label")).toMatch(/^Inbox in Mail at /);
    expect(lineUnder()).toBe(`Inbox in Mail, as it was at ${clockTime(AT + 2450)}`);
  });

  it("a run with no pictures: the read text in the viewport, and why", async () => {
    h.readStep.mockImplementation(async () => ({ text: 'app "TextEdit"\n[1] window "Untitled"' }));
    mount(data([call(1, { picture: { none: "permission" }, text: true, read: "Read 1 element" })]));
    await flush();
    expect(box()!.tagName).toBe("PRE");
    expect(lineUnder()).toBe("Screen Recording was off");
  });

  it("the picture the host no longer has is marked gone", async () => {
    h.readStep.mockImplementation(async () => ({}));
    mount(data([call(1)]));
    await flush();
    expect(h.pictureGone).toHaveBeenCalledWith("t1", 1);
  });
});

// ── the stream's ends ──

describe("when the preview ends", () => {
  it("the newest step's kept picture with today's line under it; Retry only where retrying can help", async () => {
    const cases: [PreviewState, string, boolean][] = [
      [{ status: "ended", reason: "window-closed" }, "The window closed", false],
      [{ status: "ended", reason: "minimized" }, "The window is minimized", false],
      [{ status: "ended", reason: "error" }, "The preview stopped", true],
      [{ status: "failed", message: "x" }, "The preview stopped", true],
    ];
    for (const [state, said, retry] of cases) {
      h.preview.state = state;
      mount(data([call(1), call(2)], [entry()]));
      await flush();
      expect(box()!.querySelector("img")!.getAttribute("src"), said).toMatch(/^blob:/);
      expect(lineUnder().replace("Retry", "")).toBe(said);
      expect(!!screen.queryByRole("button", { name: "Retry" }), said).toBe(retry);
      if (retry) {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(h.preview.retry).toHaveBeenCalled();
      }
      cleanup();
    }
  });

  it("with no step kept it is the line alone", async () => {
    h.preview.state = { status: "ended", reason: "window-closed" };
    mount(data([], [entry()]));
    await flush();
    expect(box()).toBeNull();
    expect(lineUnder()).toBe("The window closed");
  });

  it("live with Screen Recording off: the newest read's text in the box, and the line that says what to turn on", async () => {
    h.preview.state = { status: "ended", reason: "permission" };
    h.readStep.mockImplementation(async (_k: string, n: number) => (n === 1 ? { text: "the newest read" } : {}));
    mount(data([call(1, { picture: { none: "permission" }, text: true, read: "Read 46 elements", steps: [{ kind: "read", verb: "Read", object: "", inApp: "TextEdit", state: "ok" }] }), call(2, { picture: { none: "permission" } })], [entry()]));
    await flush();
    expect(box()!.tagName).toBe("PRE");
    expect(box()!.textContent).toBe("the newest read");
    expect(lineUnder()).toBe("Turn on Screen Recording for TempCode in System Settings");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // the open row is still the newest step
    expect(words(openRow())).toBe("ClickedStep 2");
  });
});

// ── the journal's own state ──

describe("loading, failing and older steps", () => {
  it("loading the steps: skeleton rows in the rows' shape", async () => {
    mount(data([], [], { status: "loading" }));
    await flush();
    const loading = screen.getByRole("status", { name: "Loading the steps" });
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3);
    expect(loading.querySelector(".h-7")).toBeTruthy();
  });

  it("the read failed: one red line with Retry", async () => {
    mount(data([], [], { status: "failed" }));
    await flush();
    const line = document.querySelector('[data-slot="steps-failed"]')!;
    expect(line.textContent).toBe("Couldn't read the stepsRetry");
    expect(line.className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.retry).toHaveBeenCalledWith(["t1"]);
  });

  it("a read that failed says so above the steps that are there, with Retry", async () => {
    h.preview.state = live();
    mount(data([call(1)], [entry({ running: { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: AT } })], { status: "failed" }));
    await flush();
    const line = stepList().querySelector('[data-slot="steps-failed"]')!;
    expect(line.textContent).toBe("Couldn't read the stepsRetry");
    expect(rows()).toHaveLength(1);
    expect(runningRows()).toHaveLength(1);
    // it leads the list
    expect(stepList().firstElementChild).toBe(line);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.retry).toHaveBeenCalledWith(["t1"]);
  });

  it("the first read's rows do not animate in, and a page of earlier steps neither animates nor moves the list", async () => {
    const view = mount(data([], [], { status: "loading" }));
    await flush();
    view.again(data([call(201), call(202)], [], { more: true }));
    await flush();
    expect(rows().some((r) => r.classList.contains("step-land"))).toBe(false);
    // the person scrolls down and asks for earlier steps
    stepList().scrollTop = 40;
    fireEvent.scroll(stepList());
    view.again(data([call(199), call(200), call(201), call(202)], [], { more: true }));
    await flush();
    expect(rows()).toHaveLength(4);
    expect(rows().some((r) => r.classList.contains("step-land"))).toBe(false);
    expect(stepList().scrollTop).toBe(40);
  });

  it("following, a list at its top stays there as steps land; one the person scrolled keeps its place", async () => {
    h.preview.state = live();
    const view = mount(data([call(1), call(2)], [entry()]));
    await flush();
    view.again(data([call(1), call(2), call(3)], [entry()]));
    await flush();
    expect(stepList().scrollTop).toBe(0);
    expect(rows().filter((r) => r.classList.contains("step-land")).map(words)).toEqual(["ClickedStep 3"]);
    stepList().scrollTop = 120;
    fireEvent.scroll(stepList());
    view.again(data([call(1), call(2), call(3), call(4)], [entry()]));
    await flush();
    expect(stepList().scrollTop).toBe(120);
    // back at the top it follows again
    stepList().scrollTop = 0;
    fireEvent.scroll(stepList());
    stepList().scrollTop = 3;
    view.again(data([call(1), call(2), call(3), call(4), call(5)], [entry()]));
    await flush();
    expect(stepList().scrollTop).toBe(0);
  });

  it("a pinned row whose history went is no pin: a later call with its number is not chosen for the person", async () => {
    h.preview.state = live();
    const view = mount(data([call(1), call(2)], [entry()]));
    await flush();
    fireEvent.click(rowButton("t1:1:0"));
    await flush();
    expect(screen.getByRole("button", { name: "Go live" })).toBeTruthy();
    view.again(data([], [entry()], { born: 0 }));
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    // the history begins again: its call 1 is another call, and the section follows
    view.again(data([call(1, { steps: [step("Clicked", "Other")] }), call(2, { steps: [step("Clicked", "Newest")] })], [entry()], { born: 2 }));
    await flush();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
    expect(words(openRow())).toBe("ClickedNewest");
    expect(document.querySelector('[data-slot="computer-section"]')!.hasAttribute("data-following")).toBe(true);
  });

  it("Show earlier steps loads the page under the oldest call held", async () => {
    mount(data([call(201), call(202)], [], { more: true }));
    await flush();
    const older = screen.getByRole("button", { name: "Show earlier steps" });
    await act(async () => fireEvent.click(older));
    expect(h.loadOlder).toHaveBeenCalledWith("t1");
    // none once the host has no more
    cleanup();
    mount(data([call(1)]));
    await flush();
    expect(screen.queryByRole("button", { name: "Show earlier steps" })).toBeNull();
  });

  it("a history removed and begun again shows nothing of what it was: its pictures are revoked", async () => {
    const view = mount(data([call(1)]));
    await flush();
    expect(box()!.querySelector("img")!.getAttribute("src")).toBe("blob:1");
    view.again(data([], [], { born: 0 }));
    await flush();
    expect(revoked).toEqual(["blob:1"]);
    expect(box()).toBeNull();
  });
});

// ── the cache ──

describe("the kept pictures' cache", () => {
  const callOf = (n: number, rev = 3): ComputerHistoryCall => call(n, { rev });
  const make = (limit = STEP_MEDIA_LIMIT) => {
    const made: string[] = [];
    const gone: string[] = [];
    const read = vi.fn(async (_key: string, n: number): Promise<ComputerHistoryStepAnswer> => ({ ...picture(n), text: `text ${n}` }));
    const cache = new StepMediaCache({ read, limit, createUrl: () => (made.push(`blob:${made.length + 1}`), made.at(-1)!), revokeUrl: (url) => void gone.push(url) });
    return { cache, read, made, gone };
  };

  it("holds 12, evicts the least recently used and revokes its URL", async () => {
    const { cache, gone, read } = make();
    for (let n = 1; n <= 12; n++) await cache.load("t1", callOf(n));
    expect(cache.size).toBe(12);
    expect(gone).toEqual([]);
    // touching the oldest keeps it; the next load drops the second oldest
    expect(cache.peek("t1", callOf(1))?.picture?.url).toBe("blob:1");
    await cache.load("t1", callOf(13));
    expect(cache.size).toBe(12);
    expect(gone).toEqual(["blob:2"]);
    expect(cache.peek("t1", callOf(2))).toBeUndefined();
    // a held step is not read again, and two askers share one read
    read.mockClear();
    await cache.load("t1", callOf(13));
    expect(read).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([cache.load("t1", callOf(20)), cache.load("t1", callOf(20))]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("a later revision of a call reads again, and the old picture's URL goes", async () => {
    const { cache, gone, read } = make();
    await cache.load("t1", callOf(1, 2));
    expect(cache.peek("t1", callOf(1, 3))).toBeUndefined();
    const next = await cache.load("t1", callOf(1, 3));
    expect(read).toHaveBeenCalledTimes(2);
    expect(next.picture?.url).toBe("blob:2");
    expect(gone).toEqual(["blob:1"]);
    expect(cache.size).toBe(1);
  });

  it("empties a key whose history went, and everything on clear", async () => {
    const { cache, gone } = make();
    await cache.load("t1", callOf(1));
    await cache.load("t1", callOf(2));
    await cache.load("sub1", callOf(1));
    cache.dropKey("t1");
    expect(gone.sort()).toEqual(["blob:1", "blob:2"]);
    expect(cache.size).toBe(1);
    expect(cache.peek("sub1", callOf(1))?.text).toBe("text 1");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(gone).toHaveLength(3);
  });

  it("a read still out when its key was dropped, or the cache cleared, keeps nothing: its picture is revoked as it lands", async () => {
    for (const end of ["clear", "dropKey"] as const) {
      let answer: (a: ComputerHistoryStepAnswer) => void = () => undefined;
      const made: string[] = [];
      const gone: string[] = [];
      const cache = new StepMediaCache({
        read: () => new Promise<ComputerHistoryStepAnswer>((resolve) => (answer = resolve)),
        createUrl: () => (made.push(`blob:${made.length + 1}`), made.at(-1)!),
        revokeUrl: (url) => void gone.push(url),
      });
      const load = cache.load("t1", callOf(1));
      if (end === "clear") cache.clear();
      else cache.dropKey("t1");
      answer({ ...picture(1), text: "text 1" });
      expect(await load, end).toEqual({ rev: 3 });
      expect(made, end).toEqual(["blob:1"]);
      expect(gone, end).toEqual(["blob:1"]);
      expect(cache.size, end).toBe(0);
      // dropping one key leaves another's read alone
      const other = cache.load("sub1", callOf(1));
      cache.dropKey("t1");
      answer(picture(1));
      expect((await other).picture?.url, end).toBe("blob:2");
      expect(cache.size, end).toBe(1);
    }
  });

  it("a picture is decoded before it lands, so it never takes the old one's place as a blank box", async () => {
    let settle: () => void = () => {};
    const decode = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = decode;
      },
    );
    try {
      const { cache } = make();
      let landed = false;
      const loading = cache.load("t1", callOf(1)).then(() => (landed = true));
      await new Promise((r) => setTimeout(r, 0));
      expect(decode).toHaveBeenCalledTimes(1);
      expect(landed).toBe(false);
      settle();
      await loading;
      expect(landed).toBe(true);
      // a picture that will not decode still lands: the box shows it as it loads
      decode.mockImplementationOnce(() => Promise.reject(new Error("bad jpeg")));
      await expect(cache.load("t1", callOf(2))).resolves.toMatchObject({ picture: { url: "blob:2" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says when the host no longer has a picture it listed", async () => {
    const onPictureGone = vi.fn();
    const cache = new StepMediaCache({ read: async () => ({ text: "only the text" }), onPictureGone, createUrl: () => "blob:x", revokeUrl: () => undefined });
    const media = await cache.load("t1", callOf(4));
    expect(media).toEqual({ rev: 3, text: "only the text" });
    expect(onPictureGone).toHaveBeenCalledWith("t1", 4);
    // a call that never had one is not gone
    await cache.load("t1", call(5, { picture: { none: "off" } }));
    expect(onPictureGone).toHaveBeenCalledTimes(1);
  });
});
