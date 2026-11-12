// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import type { ServerPush } from "@server/shared/contract";
import { registry } from "../../../lib/connection/registry";
import { PaneVisibilityContext, useDocumentVisible, usePaneVisible } from "../../../hooks/paneVisibility";
import { CLICK_MARK } from "../../../lib/ease";
import { PREVIEW_QUIET_MS, previewEdge } from "../../../lib/computerPreview";
import type { ComputerEntry } from "../../../lib/computerSessions";
import { ENDED_WORDS, RETRY_ENDS, VIEWPORT_INSETS, VIEWPORT_MAX, Viewport, ViewportLine, liveFace, streamSize, useLiveStream } from "./Viewport";

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
  opens = new Set<() => void>();
  closes = new Set<() => void>();
  onOpen(fn: () => void): () => void {
    this.opens.add(fn);
    return () => this.opens.delete(fn);
  }
  onClose(fn: () => void): () => void {
    this.closes.add(fn);
    return () => this.closes.delete(fn);
  }
  /** the socket drops, and comes back */
  drop(): void {
    for (const fn of [...this.closes]) fn();
  }
  reopen(): void {
    for (const fn of [...this.opens]) fn();
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
let observed: Element | null = null;
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
    observe(el: Element): void {
      observed = el;
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

/** How many times the tree around the picture rendered: a frame must never add to it. */
let renders = 0;

/** The viewport as the section draws it live: the stream while it is seen, the line alone once nothing more will come. */
function Live({ entry: en, run }: { entry: ComputerEntry | null; run: boolean }) {
  const pane = usePaneVisible();
  const doc = useDocumentVisible();
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const stream = useLiveStream(en, run && pane && doc, box, root);
  renders += 1;
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const app = state.status === "live" ? state.app : (en?.row.apps[0]?.name ?? "");
  const win = state.status === "live" ? state.window : (en?.row.apps[0]?.window ?? null);
  return (
    <div ref={root} data-testid="section">
      <Viewport
        ref={box}
        face={over || !en?.previewable ? null : liveFace(stream)}
        label={`Live view of ${win ? `${win} in ${app}` : app}`}
        size={streamSize(state)}
        line={
          over ? (
            <ViewportLine
              words={state.status === "ended" ? ENDED_WORDS[state.reason] : "The preview stopped"}
              onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined}
            />
          ) : null
        }
      />
    </div>
  );
}

function mount(e: ComputerEntry | null = entry(), props: { open?: boolean; pane?: boolean } = {}) {
  const tree = (o: { open?: boolean; pane?: boolean }, en: ComputerEntry | null) => (
    <PaneVisibilityContext.Provider value={o.pane ?? true}>
      <Live entry={en} run={o.open ?? true} />
    </PaneVisibilityContext.Provider>
  );
  const view = render(tree(props, e));
  return { ...view, again: (o: { open?: boolean; pane?: boolean }, en: ComputerEntry | null = e) => view.rerender(tree(o, en)) };
}
const box = () => screen.getByRole("img");

describe("the live viewport", () => {
  it("starts at the box's edge in device pixels and sizes the box to the stream", async () => {
    mount();
    await flush();
    expect(link.calls[0]).toEqual({ method: "computer.preview.start", params: { threadId: "s1", maxEdge: previewEdge(304 - VIEWPORT_INSETS, window.devicePixelRatio) } });
    expect(box().style.aspectRatio).toBe("960 / 600");
    // at most 240px, and 45% of the section's height where that is less: a short panel keeps its list
    expect(VIEWPORT_MAX).toBe("min(400px, 45cqh)");
    expect(box().getAttribute("style")).toContain("max-height: min(400px, 45cqh)");
    expect(box().getAttribute("aria-label")).toBe("Live view of Untitled in TextEdit");
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

  it("a dropped socket is no live picture: the box goes back to its skeleton, and a new stream starts when the socket opens", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(box().querySelector('[data-slot="skeleton"]')).toBeNull();
    // the host forgot this viewer with the socket: what is on screen is no longer the window now
    await act(async () => link.drop());
    expect(box().querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(box().style.aspectRatio).toBe("960 / 600");
    // a frame of the old stream that was still on its way draws nothing
    await act(async () => link.push(frame(2)));
    await flush();
    expect(drawn).toHaveLength(1);
    // the socket opens: a new stream is asked for, and its first frame is the picture again
    await act(async () => link.reopen());
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(2);
    await act(async () => link.push(frame(1, "pv_2")));
    await flush();
    expect(drawn).toHaveLength(2);
    expect(box().querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("waits for a window to preview: no start before the thread's first read, one when the row names its window", async () => {
    const view = mount(entry({ apps: [] }));
    await flush();
    expect(link.methods()).toEqual([]);
    // the skeleton stands in the box meanwhile
    expect(box().querySelector('[data-slot="skeleton"]')).toBeTruthy();
    view.again({}, entry());
    await flush();
    expect(link.methods()).toEqual(["computer.preview.start"]);
  });

  it("a start that failed tries again when the row's window changes, and not before", async () => {
    link.answer = async () => {
      throw new Error("No computer window to preview");
    };
    const view = mount(entry({ apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: null }] }));
    await flush();
    expect(screen.getByText("The preview stopped")).toBeTruthy();
    // the row is told again with the same window: nothing is asked twice
    view.again({}, entry({ apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: null }] }));
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    // its first read names the window: the stream starts by itself
    link.answer = async () => ({ preview: "pv_2", app: "TextEdit", window: "Untitled", width: 960, height: 600 });
    view.again({}, entry());
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(2);
    expect(screen.queryByText("The preview stopped")).toBeNull();
    expect(box().getAttribute("aria-label")).toBe("Live view of Untitled in TextEdit");
  });

  it("ignores another preview's frames", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1, "pv_9")));
    expect(drawn).toHaveLength(0);
  });

  it("a frame repaints the canvas and re-renders nothing: ten frames leave the render count where the first left it", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    // the first frame drops the skeleton: that is the one render a frame may cause
    expect(box().querySelector('[data-slot="skeleton"]')).toBeNull();
    const after = renders;
    for (let seq = 2; seq <= 11; seq++) {
      await act(async () => link.push(frame(seq)));
      await flush();
    }
    expect(drawn).toHaveLength(11);
    expect(renders).toBe(after);
    // the count the Mac proof reads is written on the box by hand
    expect(box().getAttribute("data-frames")).toBe("11");
    expect(link.methods().filter((m) => m === "computer.preview.ack")).toHaveLength(11);
    // nor does a click
    await act(async () => link.push({ push: "computer-click", preview: "pv_1", at: [480, 300], width: 960, height: 600 }));
    expect(renders).toBe(after);
    expect(box().getAttribute("data-marks")).toBe("1");
  });

  it("a change of shape is the one thing after the first frame that renders", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    const after = renders;
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", width: 600, height: 1200 }));
    expect(renders).toBeGreaterThan(after);
    expect(box().style.aspectRatio).toBe("600 / 1200");
    // the frame already drawn stays: no skeleton comes back
    expect(box().querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("stops when the section stops following (a row is pinned), on a hidden pane, a hidden document and unmount", async () => {
    const view = mount();
    await flush();
    // a pinned row: the Mac stops capturing for it
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
    await act(async () => resize?.(326));
    await act(async () => vi.advanceTimersByTime(PREVIEW_QUIET_MS));
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    await act(async () => resize?.(616));
    await act(async () => vi.advanceTimersByTime(PREVIEW_QUIET_MS - 1));
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    const starts = link.calls.filter((c) => c.method === "computer.preview.start");
    expect(starts).toHaveLength(2);
    expect(starts[1].params.maxEdge).toBe(previewEdge(616 - VIEWPORT_INSETS, window.devicePixelRatio));
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

  it("keeps measuring once the box goes, so Retry starts again at the width it had", async () => {
    mount();
    await flush();
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "ended", reason: "error" }));
    expect(screen.queryByRole("img")).toBeNull();
    // the element measured is still on the page: an ended preview's box leaving never zeroes the width
    expect(observed && document.body.contains(observed)).toBe(true);
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    await flush();
    const starts = link.calls.filter((c) => c.method === "computer.preview.start");
    expect(starts).toHaveLength(2);
    expect(starts[1].params.maxEdge).toBe(previewEdge(304 - VIEWPORT_INSETS, window.devicePixelRatio));
  });

  it("drops a frame that finished decoding after the preview ended", async () => {
    let decoded: (b: unknown) => void = () => {};
    globalThis.createImageBitmap = vi.fn(() => new Promise((r) => (decoded = r))) as never;
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "ended", reason: "window-closed" }));
    await act(async () => decoded({ width: 960, height: 600, close: vi.fn() }));
    await flush();
    expect(drawn).toHaveLength(0);
    expect(screen.getByText("The window closed")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("follows the agent to another window on the same preview id", async () => {
    mount();
    await flush();
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "Mail", window: "Inbox", width: 600, height: 1200 }));
    expect(box().getAttribute("aria-label")).toBe("Live view of Inbox in Mail");
    expect(box().style.aspectRatio).toBe("600 / 1200");
  });

  it("another window is drawn by its own first frame alone: the old window's picture is never shown as it, and a frame of the old one still decoding is dropped", async () => {
    const skeleton = () => box().querySelector('[data-slot="skeleton"], .animate-pulse');
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(drawn).toHaveLength(1);
    expect(skeleton()).toBeNull();
    // a frame of the first window is still decoding when the host moves the stream to another window
    let decoded: (b: unknown) => void = () => {};
    globalThis.createImageBitmap = vi.fn(() => new Promise((r) => (decoded = r))) as never;
    await act(async () => link.push(frame(2)));
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "Mail", window: "Inbox", width: 600, height: 1200 }));
    // the box is Mail's now, in Mail's shape, and nothing of Mail has been drawn: the skeleton, not TextEdit's last frame
    expect(box().getAttribute("aria-label")).toBe("Live view of Inbox in Mail");
    expect(skeleton()).not.toBeNull();
    await act(async () => decoded({ width: 960, height: 600, close: vi.fn() }));
    await flush();
    expect(drawn).toHaveLength(1);
    expect(skeleton()).not.toBeNull();
    // dropped, and acked all the same: the host's gate must not wait on a frame nobody will draw
    expect(link.calls.filter((c) => c.method === "computer.preview.ack").map((c) => (c.params as { seq: number }).seq)).toEqual([1, 2]);
    // Mail's own first frame is its picture
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 600, height: 1200, close: vi.fn() })) as never;
    await act(async () => link.push(frame(3)));
    await flush();
    expect(drawn).toHaveLength(2);
    expect(skeleton()).toBeNull();
    // the same window in another size is the same picture
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "Mail", window: "Inbox", width: 700, height: 1200 }));
    expect(skeleton()).toBeNull();
    // a stream that ended and came back starts from nothing drawn too
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "ended", reason: "window-minimized" }));
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "Mail", window: "Inbox", width: 700, height: 1200 }));
    expect(skeleton()).not.toBeNull();
    await act(async () => link.push(frame(4)));
    await flush();
    expect(skeleton()).toBeNull();
  });

  it("two windows of one app and one title are two windows: the host says which, and the second is drawn by its own first frame", async () => {
    const skeleton = () => box().querySelector('[data-slot="skeleton"], .animate-pulse');
    link.answer = async () => ({ preview: "pv_1", app: "TextEdit", window: "Untitled", target: "16800:1581", width: 960, height: 600 });
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(skeleton()).toBeNull();
    // the same window at another size (the stream started again at a larger edge): the picture stays
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "TextEdit", window: "Untitled", target: "16800:1581", width: 1200, height: 750 }));
    expect(skeleton()).toBeNull();
    // another "Untitled": a frame of the first still decoding is dropped and acked, and the skeleton holds
    let decoded: (b: unknown) => void = () => {};
    globalThis.createImageBitmap = vi.fn(() => new Promise((r) => (decoded = r))) as never;
    await act(async () => link.push(frame(2)));
    await act(async () => link.push({ push: "computer-preview", preview: "pv_1", state: "live", app: "TextEdit", window: "Untitled", target: "16800:1590", width: 960, height: 600 }));
    expect(skeleton()).not.toBeNull();
    await act(async () => decoded({ width: 960, height: 600, close: vi.fn() }));
    await flush();
    expect(drawn).toHaveLength(1);
    expect(skeleton()).not.toBeNull();
    expect(link.calls.filter((c) => c.method === "computer.preview.ack").map((c) => (c.params as { seq: number }).seq)).toEqual([1, 2]);
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 960, height: 600, close: vi.fn() })) as never;
    await act(async () => link.push(frame(3)));
    await flush();
    expect(drawn).toHaveLength(2);
    expect(skeleton()).toBeNull();
  });

  it("another session's box starts from nothing: the last session's picture is never shown under it, with or without a window of its own to stream", async () => {
    const skeleton = () => box().querySelector('[data-slot="skeleton"], .animate-pulse');
    const view = mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(skeleton()).toBeNull();
    // the section follows another session, which has read no window yet (it only listed or launched apps)
    const other: ComputerEntry = { ...entry({ threadId: "s2", apps: [] }), previewKey: "s2" };
    view.again({}, other);
    await flush();
    // the first session's stream is stopped, no stream is asked for the second, and its box is the skeleton
    expect(link.methods().at(-1)).toBe("computer.preview.stop");
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(1);
    expect(skeleton()).not.toBeNull();
    // it reads a window: its stream starts, and only its own first frame is its picture
    link.answer = async () => ({ preview: "pv_2", app: "Mail", window: "Inbox", width: 600, height: 1200 });
    view.again({}, { ...entry({ threadId: "s2", apps: [{ name: "Mail", bundleId: "com.apple.mail", window: "Inbox" }] }), previewKey: "s2" });
    await flush();
    expect(link.methods().filter((m) => m === "computer.preview.start")).toHaveLength(2);
    expect(skeleton()).not.toBeNull();
    await act(async () => link.push(frame(2, "pv_2")));
    await flush();
    expect(skeleton()).toBeNull();
    expect(box().getAttribute("aria-label")).toBe("Live view of Inbox in Mail");
  });

  it("a window that changes shape under the stream is drawn in its new shape: the box takes the frame's own, once", async () => {
    mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(box().style.aspectRatio).toBe("960 / 600");
    const before = renders;
    // the window grew taller: the service sends frames of the new shape, and no other word of it
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 960, height: 900, close: vi.fn() })) as never;
    await act(async () => link.push(frame(2)));
    await flush();
    expect(box().style.aspectRatio).toBe("960 / 900");
    const after = renders;
    expect(after).toBeGreaterThan(before);
    // later frames of that shape render nothing
    await act(async () => link.push(frame(3)));
    await act(async () => link.push(frame(4)));
    await flush();
    expect(renders).toBe(after);
    // a pixel of rounding is not another shape
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 959, height: 900, close: vi.fn() })) as never;
    await act(async () => link.push(frame(5)));
    await flush();
    expect(box().style.aspectRatio).toBe("960 / 900");
  });

  it("a stream that was stopped leaves nothing called live: following again starts from the skeleton in its shape", async () => {
    const skeleton = () => box().querySelector('[data-slot="skeleton"], .animate-pulse');
    const view = mount();
    await flush();
    await act(async () => link.push(frame(1)));
    await flush();
    expect(skeleton()).toBeNull();
    // a row is pinned: the stream stops
    view.again({ open: false });
    await flush();
    expect(link.methods().at(-1)).toBe("computer.preview.stop");
    // Go live: the box is the skeleton, in the shape it had, until the new stream's first frame
    link.answer = () => new Promise(() => {});
    view.again({ open: true });
    expect(skeleton()).not.toBeNull();
    expect(box().style.aspectRatio).toBe("960 / 600");
  });

  it("asks for no frames with no session to draw, or one this desktop cannot draw", async () => {
    mount(null);
    await flush();
    expect(screen.queryByRole("img")).toBeNull();
    expect(link.calls).toHaveLength(0);
    cleanup();
    mount(entry({}, false));
    await flush();
    expect(screen.queryByRole("img")).toBeNull();
    expect(link.calls).toHaveLength(0);
  });
});

describe("the viewport's faces", () => {
  const still = <img alt="" src="data:," />;
  it("a kept picture is a button named for what it shows, and a click opens it from the box", () => {
    const onOpen = vi.fn();
    render(<Viewport face={{ kind: "picture", src: "blob:kept", onOpen }} label="Untitled in TextEdit at 2:04 PM" size={{ width: 960, height: 804 }} />);
    const button = screen.getByRole("button", { name: "Untitled in TextEdit at 2:04 PM" });
    expect(button.getAttribute("data-face")).toBe("picture");
    expect(button.style.aspectRatio).toBe("960 / 804");
    expect(button.querySelector("img")?.getAttribute("src")).toBe("blob:kept");
    // no frame count on a picture that is not the stream
    expect(button.hasAttribute("data-frames")).toBe(false);
    button.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("the old picture dims while the next is on its way, over the fast fade and nothing else", () => {
    const { rerender } = render(<Viewport face={{ kind: "picture", src: "blob:a" }} label="x" />);
    const img = () => document.querySelector("img")!;
    expect(img().className).not.toContain("opacity-40");
    expect(img().className).toContain("transition-opacity");
    expect(img().className).toContain("duration-(--dur-fast)");
    expect(img().className).toContain("motion-reduce:transition-opacity");
    rerender(<Viewport face={{ kind: "picture", src: "blob:a", dim: true }} label="x" />);
    expect(img().className).toContain("opacity-40");
    expect(img().getAttribute("data-dim")).toBe("true");
  });

  it("the live box does not open the lightbox: it is a picture, not a button", () => {
    render(<Viewport face={{ kind: "live", picture: still, drawn: true }} label="Live view of Untitled in TextEdit" frames={3} marks={1} />);
    const live = screen.getByRole("img", { name: "Live view of Untitled in TextEdit" });
    expect(live.tagName).toBe("DIV");
    expect([live.getAttribute("data-frames"), live.getAttribute("data-marks"), live.getAttribute("data-face")]).toEqual(["3", "1", "live"]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("with no picture it shows what the model read, in a console of the box's shape the keyboard reaches", () => {
    render(<Viewport face={{ kind: "text", text: 'app "TextEdit"\n[1] window "Untitled"' }} label="What was read of Untitled in TextEdit" line={<ViewportLine words="Screen Recording was off" />} />);
    const pre = document.querySelector("pre")!;
    expect(pre.getAttribute("data-face")).toBe("text");
    expect(pre.tabIndex).toBe(0);
    expect(pre.getAttribute("aria-label")).toBe("What was read of Untitled in TextEdit");
    expect(pre.textContent).toContain('[1] window "Untitled"');
    expect(pre.className.split(/\s+/)).toEqual(expect.arrayContaining(["whitespace-pre", "overflow-x-auto", "overflow-y-auto", "focus-ring", "font-mono"]));
    expect(pre.style.aspectRatio).toBe("16 / 10");
    expect(screen.getByText("Screen Recording was off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a first picture on its way is a skeleton in the picture's shape", () => {
    render(<Viewport face={{ kind: "skeleton" }} label="Untitled in TextEdit at 2:04 PM" size={{ width: 930, height: 1280 }} />);
    const boxEl = screen.getByRole("img");
    expect(boxEl.style.aspectRatio).toBe("930 / 1280");
    expect(boxEl.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(boxEl.querySelector("[data-slot=computer-picture]")!.getAttribute("style")).toContain("930 / 1280");
  });

  it("pinned, the box keeps the height it is given and centres a picture of another shape", () => {
    render(<Viewport face={{ kind: "picture", src: "blob:tall" }} label="x" size={{ width: 930, height: 1280 }} height={190} />);
    const boxEl = screen.getByRole("img");
    expect(boxEl.style.height).toBe("190px");
    expect(boxEl.style.aspectRatio).toBe("");
    expect(boxEl.className).toContain("justify-center");
    expect(boxEl.className).toContain("items-center");
    const picture = boxEl.querySelector<HTMLElement>("[data-slot=computer-picture]")!;
    expect(picture.style.aspectRatio).toBe("930 / 1280");
    // as wide as the kept height allows (190 × 930 / 1280), and never wider than the box
    expect(picture.getAttribute("style")).toContain("width: min(100%, 138px)");
    expect(picture.className.split(/\s+/)).not.toContain("h-full");
  });

  it("no face is the line alone, and nothing at all with no line", () => {
    const { container, rerender } = render(<Viewport face={null} label="x" line={<ViewportLine words="The window closed" />} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("The window closed")).toBeTruthy();
    rerender(<Viewport face={null} label="x" />);
    expect(container.innerHTML).toBe("");
  });
});
