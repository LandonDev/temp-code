// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import type { ServerPush } from "@server/shared/contract";
import { registry } from "../../lib/connection/registry";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";
import { CLICK_MARK } from "../../lib/ease";
import { PREVIEW_QUIET_MS, previewEdge } from "../../lib/computerPreview";
import type { ComputerEntry } from "../../lib/computerSessions";
import { ComputerPreview } from "./ComputerPreview";

/** A stand-in for this Mac's link: records requests in order and lets the test push. */
class FakeLink {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  listeners = new Set<(p: ServerPush) => void>();
  started = 0;
  answer: (params: Record<string, unknown>) => Promise<unknown> = async () => ({ preview: `pv_${++this.started}`, app: "TextEdit", window: "Untitled", width: 960, height: 600 });
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    this.calls.push({ method, params });
    if (method === "computer.preview.start") return this.answer(params);
    return null;
  });
  onPush(fn: (p: ServerPush) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  push(p: Record<string, unknown>): void {
    for (const fn of this.listeners) fn(p as ServerPush);
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

let link: FakeLink;
let width = 304;
let resize: ((width: number) => void) | null = null;
const drawn: unknown[] = [];
const animate = vi.fn();
let reduced = false;

beforeEach(() => {
  link = new FakeLink();
  width = 304;
  drawn.length = 0;
  reduced = false;
  vi.spyOn(registry, "link").mockImplementation(() => link as never);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  globalThis.ResizeObserver = class {
    constructor(private fn: ResizeObserverCallback) {}
    observe(): void {
      resize = (w) => this.fn([{ contentRect: { width: w } } as ResizeObserverEntry], this as never);
    }
    disconnect(): void {
      resize = null;
    }
    unobserve(): void {}
  } as never;
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 960, height: 600, close: vi.fn() })) as never;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: (b: unknown) => drawn.push(b) })) as never;
  Element.prototype.animate = animate as never;
  Element.prototype.getAnimations = () => [];
  window.matchMedia = vi.fn(() => ({ matches: reduced })) as never;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  animate.mockReset();
});

const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "s1",
  since: 1,
  lastCallAt: 1,
  apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }],
  running: null,
  tier: "ax",
  ...over,
});
const entry = (over: Partial<ComputerSessionRow> = {}, previewable = true): ComputerEntry => ({
  host: "local",
  row: row(over),
  previewable,
  ...(previewable ? { previewHost: "local", previewKey: "s1" } : {}),
});
const flush = () => act(async () => {});
const frame = (seq: number, preview = "pv_1") => ({ push: "computer-frame", preview, seq, width: 960, height: 600, data: btoa("jpeg") });

function mount(e = entry(), props: { open?: boolean; pane?: boolean } = {}) {
  const tree = (o: { open?: boolean; pane?: boolean }, en: ComputerEntry) => (
    <PaneVisibilityContext.Provider value={o.pane ?? true}>
      <ComputerPreview entry={en} open={o.open ?? true} />
    </PaneVisibilityContext.Provider>
  );
  const view = render(tree(props, e));
  return { ...view, again: (o: { open?: boolean; pane?: boolean }, en = e) => view.rerender(tree(o, en)) };
}
const box = () => screen.getByRole("img");

describe("ComputerPreview", () => {
  it("starts at the box's edge in device pixels and sizes the box to the stream", async () => {
    mount();
    await flush();
    expect(link.calls[0]).toEqual({ method: "computer.preview.start", params: { threadId: "s1", maxEdge: previewEdge(304, window.devicePixelRatio) } });
    expect(box().style.aspectRatio).toBe("960 / 600");
    expect(box().style.maxHeight).toBe("240px");
    expect(box().getAttribute("aria-label")).toBe("Preview of Untitled in TextEdit");
    expect(box().querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("sizes the box by the stream's shape alone, 16:10 until the start answers, and centres the picture in it", async () => {
    link.answer = () => new Promise(() => {});
    mount();
    await flush();
    expect(box().style.aspectRatio).toBe("16 / 10");
    expect(box().className).toContain("justify-center");
    const picture = box().querySelector<HTMLElement>('[data-slot="computer-picture"]')!;
    expect(picture.className).toContain("h-full");
    expect(picture.className).toContain("max-w-full");
    expect(picture.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("draws a frame and only then acks it, with no transition on the picture", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(drawn).toHaveLength(1);
    expect(link.methods()).toEqual(["computer.preview.start", "computer.preview.ack"]);
    expect(link.calls[1].params).toEqual({ preview: "pv_1", seq: 1 });
    expect(box().getAttribute("data-frames")).toBe("1");
    expect(box().querySelector("canvas")?.className).not.toMatch(/transition/);
    expect(box().querySelector('[data-slot="skeleton"], .animate-pulse')).toBeNull();
  });

  it("ignores another preview's frames", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1, "pv_9")));
    expect(drawn).toHaveLength(0);
  });

  it("stops on a closed fold, a hidden pane, a hidden document and unmount", async () => {
    const view = mount();
    await flush();
    view.again({ open: false });
    await flush();
    expect(link.methods()).toEqual(["computer.preview.start", "computer.preview.stop"]);
    view.again({ open: true });
    await flush();
    view.again({ open: true, pane: false });
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.stop")).toHaveLength(2);
    view.again({ open: true, pane: true });
    await flush();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.stop")).toHaveLength(3);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    view.unmount();
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.stop")).toHaveLength(4);
    expect(link.calls.filter((c) => c.method === "computer.preview.stop").map((c) => c.params.preview)).toEqual(["pv_1", "pv_2", "pv_3", "pv_4"]);
  });

  it("asks again at a larger edge once a grown box has been quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    width = 300;
    mount();
    await flush();
    await act(async () => resize?.(310));
    await act(async () => vi.advanceTimersByTime(PREVIEW_QUIET_MS));
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    await act(async () => resize?.(600));
    await act(async () => vi.advanceTimersByTime(PREVIEW_QUIET_MS - 1));
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    const starts = link.calls.filter((c) => c.method === "computer.preview.start");
    expect(starts).toHaveLength(2);
    expect(starts[1].params.maxEdge).toBe(previewEdge(600, window.devicePixelRatio));
  });

  it("marks a click at its share of the picture by the click's own size, with or without a frame, restarted each time", async () => {
    mount();
    await flush();
    const at = box().querySelector('[data-slot="click-mark"]')!.parentElement as HTMLElement;
    await act(async () => link.push({ push: "computer-click", preview: "pv_1", at: [480, 300], width: 960, height: 600 }));
    expect([at.style.left, at.style.top]).toEqual(["50%", "50%"]);
    // a click sized for a stream that grew before its first frame landed
    await act(async () => link.push({ push: "computer-click", preview: "pv_1", at: [1280, 0], width: 1280, height: 800 }));
    expect([at.style.left, at.style.top]).toEqual(["100%", "0%"]);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate).toHaveBeenLastCalledWith(CLICK_MARK.keyframes, CLICK_MARK.timing);
    expect(box().getAttribute("data-marks")).toBe("2");
    expect(drawn).toHaveLength(0);
  });

  it("plays the mark's fade alone under reduced motion", async () => {
    reduced = true;
    mount();
    await flush();
    await act(async () => link.push({ push: "computer-click", preview: "pv_1", at: [1, 1], width: 960, height: 600 }));
    expect(animate).toHaveBeenCalledWith(CLICK_MARK.reduced, CLICK_MARK.timing);
    expect(CLICK_MARK.reduced.every((k) => !("transform" in k))).toBe(true);
  });

  it("says why it ended, with Retry only where retrying can help", async () => {
    const cases: [string, string, boolean][] = [
      ["window-closed", "The window closed", false],
      ["minimized", "The window is minimized", false],
      ["permission", "Turn on Screen Recording for TempCode in System Settings", false],
      ["restarted", "The preview stopped", true],
      ["error", "The preview stopped", true],
    ];
    for (const [reason, words, retry] of cases) {
      link = new FakeLink();
      const view = mount();
      await flush();
      await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "ended", reason }));
      expect(screen.getByText(words)).toBeTruthy();
      // Nothing more comes into the box: the line alone, no skeleton that reads as loading.
      expect(screen.queryByRole("img")).toBeNull();
      expect(!!screen.queryByRole("button", { name: "Retry" }), reason).toBe(retry);
      if (retry) {
        await act(async () => screen.getByRole("button", { name: "Retry" }).click());
        await flush();
        expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(2);
      }
      view.unmount();
    }
  });

  it("says an end that came while its start waited, from the start's own answer", async () => {
    link.answer = async () => ({ preview: "pv_1", app: "TextEdit", window: "Untitled", width: 0, height: 0, ended: "minimized" });
    mount();
    await flush();
    expect(screen.getByText("The window is minimized")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("follows the agent to another window on the same preview id", async () => {
    mount();
    await flush();
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "Mail", window: "Inbox", width: 600, height: 1200 }));
    expect(box().getAttribute("aria-label")).toBe("Preview of Inbox in Mail");
    expect(box().style.aspectRatio).toBe("600 / 1200");
  });

  it("says what a held step waits on, and a card waiting on the Mac before that, in the status vocabulary", async () => {
    const held = mount(entry({ running: { tool: "computer_act", words: "Waiting for the Mac to be free, 2nd in line", startedAt: 1, held: true } }));
    await flush();
    const line = document.querySelector('[data-slot="computer-held"]')!;
    expect(line.getAttribute("data-state")).toBe("queued");
    expect(line.textContent).toContain("Waiting for the Mac to be free, 2nd in line");
    held.unmount();
    mount(entry({ asking: { line: "Click Save in TextEdit?" }, running: { tool: "computer_act", words: "x", startedAt: 1, held: true } }));
    await flush();
    const asking = document.querySelector('[data-slot="computer-asking"]')!;
    expect(asking.getAttribute("data-state")).toBe("waiting");
    expect(asking.textContent).toContain("Needs you");
    expect(asking.textContent).toContain("Click Save in TextEdit?");
    expect(document.querySelector('[data-slot="computer-held"]')).toBeNull();
  });

  it("shows the line alone, and asks for no frames, where this desktop cannot preview", async () => {
    mount(entry({ asking: { line: "Click Save in TextEdit?" } }, false));
    await flush();
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector('[data-slot="computer-asking"]')).toBeTruthy();
    expect(link.calls).toHaveLength(0);
  });
});
