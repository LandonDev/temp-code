// UI-22: the whole transcript under timed pushes, for the no-jerk scenarios.
import { act, render, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";
import { createElement } from "react";
import type { Block } from "../lib/session";
import { AgentTranscript } from "./AgentTranscript";

/**
 * jsdom lays nothing out, so the transcript's window needs a layout it can
 * read: a scroller 600px tall, and ResizeObserver and IntersectionObserver
 * stand-ins whose measurements a test fires (`measure`). Install once per
 * file, before the first render (AgentTranscript.wait.dom.test.tsx's setup).
 * A test file still mocks what it must at its top (vi.mock is hoisted there):
 * the highlighter, the sounds, and reduced motion when it wants it.
 */
type Callback = (entries: ResizeObserverEntry[]) => void;
const observers = new Set<{ callback: Callback; targets: Set<Element> }>();

export function installTranscriptLayout(): void {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private entry: { callback: Callback; targets: Set<Element> };
    constructor(callback: Callback) {
      this.entry = { callback, targets: new Set() };
      observers.add(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.add(el);
    }
    unobserve(el: Element) {
      this.entry.targets.delete(el);
    }
    disconnect() {
      observers.delete(this.entry);
    }
  };
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("agent-transcript") ? 600 : 0;
    },
  });
}

/** Fire a measurement of `height` px for the mounted row `key`. */
export function measure(key: string, height: number): void {
  for (const { callback, targets } of observers) {
    const target = [...targets].find((el) => (el as HTMLElement).dataset.row === key);
    if (!target) continue;
    act(() =>
      callback([{ target, contentRect: { height } as DOMRectReadOnly, borderBoxSize: [{ blockSize: height, inlineSize: 800 }] } as unknown as ResizeObserverEntry]),
    );
  }
}

export type Shown = { status?: string; activity?: string | null };

/** One transcript under test: `show` pushes the next state of the thread. */
export type Scene = RenderResult & {
  show(blocks: Block[], busy: boolean, extra?: Shown): void;
  /** The turn's working or closing line. */
  line(): HTMLElement | null;
  /** The bubble of the person's message `n` (0-based) on screen. */
  bubble(n?: number): HTMLElement | null;
  /** The scroller. */
  scroller(): HTMLElement;
  /** Every row element on screen, by key. */
  rows(): Map<string, HTMLElement>;
};

function element(sessionId: string, blocks: Block[], busy: boolean, extra: Shown) {
  const status = extra.status ?? (busy ? "running" : "idle");
  const turn = { id: sessionId, status, busy, blocks, activity: extra.activity ?? undefined };
  // A pane: the slot above the composer holds the live state, so the transcript draws no liveState line.
  return createElement(AgentTranscript, { sessionId, turn, blocks, busy, visible: true, liveState: false } as never);
}

export function scene(sessionId: string, blocks: Block[], busy: boolean, extra: Shown = {}): Scene {
  const view = render(element(sessionId, blocks, busy, extra));
  const { container } = view;
  return Object.assign(view, {
    show(next: Block[], nextBusy: boolean, nextExtra: Shown = {}) {
      view.rerender(element(sessionId, next, nextBusy, nextExtra));
    },
    line: () => container.querySelector<HTMLElement>('[data-slot="turn-line"]'),
    bubble: (n = 0) => container.querySelectorAll<HTMLElement>("[data-user-bubble]")[n] ?? null,
    scroller: () => container.querySelector<HTMLElement>(".agent-transcript")!,
    rows: () => new Map([...container.querySelectorAll<HTMLElement>("[data-row]")].map((el) => [el.dataset.row!, el])),
  });
}

/** Let timers and Motion's frames run for `ms` (real time). */
export const settle = (ms = 400) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Settle in steps until `done` holds (a drain, a hold), at most `ms`; the
 *  steps matter: one act spanning it all would batch the renders a chain of
 *  timers needs. */
export async function settleUntil(done: () => boolean, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 200) await settle(200);
}

/**
 * The no-jerk rules, checked after every step of a scenario (docs/TRANSCRIPT.md
 * "No jerk in any scenario"): a row still on screen is the same element and
 * never takes a fade it did not have; the turn's line, once live, is the
 * same element; a morph settles to one set of words.
 */
export function watch(view: Scene) {
  let rows = view.rows();
  let line: HTMLElement | null = null;
  return {
    check(label: string): void {
      const now = view.rows();
      for (const [key, el] of rows) {
        const again = now.get(key);
        if (!again) continue;
        expect(again, `${label}: row ${key} remounted`).toBe(el);
        if (!el.className.includes("z-fade-in")) expect(again.className, `${label}: row ${key} faded again`).not.toContain("z-fade-in");
      }
      rows = now;
      const current = view.line();
      if (line && line.isConnected) expect(current, `${label}: the turn's line remounted`).toBe(line);
      line = current ?? line;
    },
    /** After a step has settled: every morph shows one set of words. */
    settled(label: string): void {
      for (const morph of view.container.querySelectorAll("[data-slot=morph-text]")) {
        expect(morph.querySelectorAll(":scope > [data-morph-key]").length, `${label}: two words in one place`).toBeLessThanOrEqual(1);
      }
    },
  };
}

/** Every value the line's words took, with when, as the line painted them. */
export function phaseLog(view: Scene): { log: { key: string; at: number }[]; stop(): void } {
  const log: { key: string; at: number }[] = [];
  const read = () => {
    const key = view.line()?.querySelector("[data-morph-key]")?.getAttribute("data-morph-key") ?? null;
    if (key && log[log.length - 1]?.key !== key) log.push({ key, at: performance.now() });
  };
  read();
  const observer = new MutationObserver(read);
  observer.observe(view.container, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-morph-key"] });
  return { log, stop: () => observer.disconnect() };
}
