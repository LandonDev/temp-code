// @vitest-environment jsdom
/**
 * The transcript's viewport window under jsdom, which lays nothing out: the
 * scroller is given a 600px viewport and a scrollHeight read off the sized
 * container, rows measure through a ResizeObserver the test fires itself,
 * and reduced motion turns every glide into a plain scroll write.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

type Callback = (entries: ResizeObserverEntry[]) => void;
const observers = new Set<{ callback: Callback; targets: Set<Element> }>();
class FakeResizeObserver {
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
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Fire a measurement for every mounted row: `heightOf(key)` px each, or
 *  null to leave that row unmeasured. */
function measureRows(heightOf: (key: string) => number | null): void {
  for (const { callback, targets } of observers) {
    const entries: ResizeObserverEntry[] = [];
    for (const target of targets) {
      const key = (target as HTMLElement).dataset.row;
      if (key === undefined) continue;
      const height = heightOf(key);
      if (height === null) continue;
      entries.push({
        target,
        contentRect: { height } as DOMRectReadOnly,
        borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
      } as unknown as ResizeObserverEntry);
    }
    if (entries.length > 0) act(() => callback(entries));
  }
}

const VIEWPORT = 600;
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("agent-transcript") ? VIEWPORT : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (!this.classList.contains("agent-transcript")) return 0;
    const box = this.firstElementChild?.firstElementChild as HTMLElement | null;
    return box ? parseFloat(box.style.height) || 0 : 0;
  },
});

import { AgentTranscript, shouldRestoreScroll } from "./AgentTranscript";
import type { Block } from "../lib/session";
import { requestTranscriptJump } from "../lib/transcriptJump";
import type { TranscriptScrollMemory } from "../lib/transcriptScrollMemory";

/** `turns` chat turns of a prompt, a Read call and an answer, as the long
 *  chat the iOS test server seeds; block ids carry the turn number. */
function chat(turns: number, from = 0): Block[] {
  const blocks: Block[] = [];
  for (let t = from; t < from + turns; t++) {
    blocks.push({ id: `u${t}`, role: "user", text: `Turn ${t + 1}`, seq: t * 4 + 1 });
    blocks.push({
      id: `t${t}`,
      role: "tool",
      text: `Read row-${t}.ts`,
      tool: { callId: `c${t}`, name: "Read", kind: "read", status: "completed", title: `Read row-${t}.ts`, input: { file_path: `/repo/row-${t}.ts` } },
    });
    blocks.push({ id: `a${t}`, role: "assistant", text: `Row ${t} says ${t * 4 + 1}.`, seq: t * 4 + 4 });
  }
  return blocks;
}

const scrollerOf = (container: HTMLElement) => container.querySelector(".agent-transcript") as HTMLDivElement;
const boxOf = (container: HTMLElement) => scrollerOf(container).firstElementChild!.firstElementChild as HTMLDivElement;
const rowKeys = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-row]")].map((el) => el.dataset.row!);
const blockIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-block]")].map((el) => el.dataset.block!);
const topOf = (el: HTMLElement) => parseFloat(el.style.top);

/** The mounted row the top edge of the viewport cuts through. */
const anchorKeyOf = (container: HTMLElement, scrollTop: number): string => {
  let best: HTMLElement | null = null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-row]")) {
    if (topOf(row) <= scrollTop && (!best || topOf(row) > topOf(best))) best = row;
  }
  return best!.dataset.row!;
};

/** A reader's scroll: the wheel releases the engine, then the offset moves. */
const scrollTo = (el: HTMLElement, top: number) =>
  act(() => {
    fireEvent.wheel(el, { deltaY: -120 });
    el.scrollTop = top;
    fireEvent.scroll(el);
  });

beforeEach(() => observers.clear());
afterEach(cleanup);

describe("shouldRestoreScroll", () => {
  const memory: TranscriptScrollMemory = { anchor: { key: "a10", offset: 4 } };

  it("puts the reader back where they scrolled up from while the run is still going", () => {
    expect(shouldRestoreScroll(memory, true)).toBe(true);
  });

  it("sends a settled thread to the bottom, discarding a scroll-up from before it finished", () => {
    expect(shouldRestoreScroll(memory, false)).toBe(false);
    expect(shouldRestoreScroll(memory, undefined)).toBe(false);
  });

  it("has nothing to restore when the thread never left the bottom", () => {
    expect(shouldRestoreScroll(undefined, true)).toBe(false);
    expect(shouldRestoreScroll(undefined, false)).toBe(false);
  });
});

describe("AgentTranscript viewport window", () => {
  it("mounts the rows of the last screen and one screen above it, never the thread", () => {
    const { container } = render(
      <AgentTranscript sessionId="s1" blocks={chat(500)} busy={false} visible />,
    );
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    // 500 turns of four rows: the container is the whole thread tall.
    expect(total).toBeGreaterThan(50_000);
    // Opened at the bottom: the last rows are in, the first are not.
    expect(el.scrollTop).toBe(total);
    const keys = rowKeys(container);
    expect(keys.length).toBeLessThan(60);
    expect(keys.at(-1)).toBe("u499:end");
    expect(blockIds(container)).toContain("u499");
    expect(blockIds(container)).not.toContain("u0");
    // Rows sit at their offsets and carry their turn.
    const first = container.querySelector<HTMLElement>("[data-row]")!;
    expect(topOf(first)).toBeGreaterThan(total - 3 * VIEWPORT);
    expect(first.dataset.turn).toBeDefined();
  });

  it("scrolling up mounts the rows there and drops the ones two screens behind", () => {
    const { container } = render(
      <AgentTranscript sessionId="s2" blocks={chat(500)} busy={false} visible />,
    );
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    scrollTo(el, total / 2);
    const keys = rowKeys(container);
    expect(keys.length).toBeLessThan(60);
    expect(keys).not.toContain("u499:end");
    expect(keys).not.toContain("u0");
    const first = container.querySelector<HTMLElement>("[data-row]")!;
    expect(topOf(first)).toBeGreaterThan(total / 2 - 2 * VIEWPORT);
    expect(topOf(first)).toBeLessThan(total / 2);
    // A small scroll inside the mounted band renders nothing new.
    scrollTo(el, total / 2 + 100);
    expect(rowKeys(container)).toEqual(keys);
  });

  it("measured heights replace the estimates and move the rows below, not the reader", () => {
    const { container } = render(
      <AgentTranscript sessionId="s3" blocks={chat(200)} busy={false} visible />,
    );
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    scrollTo(el, total / 2);
    const before = el.scrollTop;
    const keys = rowKeys(container);
    const anchor = anchorKeyOf(container, before);
    const anchorEl = container.querySelector<HTMLElement>(`[data-row="${anchor}"]`)!;
    const onScreen = topOf(anchorEl) - before;
    const above = keys.slice(0, keys.indexOf(anchor));
    const belowEl = container.querySelector<HTMLElement>(`[data-row="${keys[keys.indexOf(anchor) + 2]}"]`)!;
    const gapBelow = topOf(belowEl) - topOf(anchorEl);
    // Every row above the reader measures 50px taller than its estimate;
    // the rows below measure what they were estimated at (the last mounted
    // row, whose estimate the test cannot read off the next one, stays).
    measureRows((key) => {
      const row = container.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
      const next = container.querySelector<HTMLElement>(`[data-row="${keys[keys.indexOf(key) + 1]}"]`);
      if (!next) return null;
      const estimate = topOf(next) - topOf(row);
      return above.includes(key) ? estimate + 50 : estimate;
    });
    expect(parseFloat(boxOf(container).style.height)).toBeCloseTo(total + 50 * above.length, 1);
    expect(el.scrollTop).toBeCloseTo(before + 50 * above.length, 1);
    // The anchor row kept its place on screen, and so did the rows below it.
    expect(topOf(anchorEl) - el.scrollTop).toBeCloseTo(onScreen, 1);
    expect(topOf(belowEl) - topOf(anchorEl)).toBe(gapBelow);
  });

  it("rows landing above keep the reader's row where it was", () => {
    const { container, rerender } = render(
      <AgentTranscript sessionId="s4" blocks={chat(100, 100)} busy={false} visible />,
    );
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    scrollTo(el, total / 2);
    const anchor = anchorKeyOf(container, el.scrollTop);
    const anchorEl = container.querySelector<HTMLElement>(`[data-row="${anchor}"]`)!;
    const onScreen = topOf(anchorEl) - el.scrollTop;
    // A hundred older turns land above (a page of history).
    rerender(<AgentTranscript sessionId="s4" blocks={[...chat(100), ...chat(100, 100)]} busy={false} visible />);
    const grown = parseFloat(boxOf(container).style.height);
    // Twice as tall, give or take the closing row only the last turn has.
    expect(Math.abs(grown - total * 2)).toBeLessThan(60);
    const again = container.querySelector<HTMLElement>(`[data-row="${anchor}"]`)!;
    expect(topOf(again) - el.scrollTop).toBeCloseTo(onScreen, 0);
    expect(el.scrollTop).toBeGreaterThan(total / 2 + total * 0.9);
  });

  it("a search hit inside the window glides to its row; one outside mounts it and lands exactly", () => {
    const { container } = render(
      <AgentTranscript sessionId="s5" blocks={chat(500)} busy={false} visible />,
    );
    const el = scrollerOf(container);
    // Outside the window: the top of the thread.
    act(() => requestTranscriptJump("s5", 1));
    expect(blockIds(container)).toContain("u0");
    const u0 = container.querySelector<HTMLElement>('[data-row="u0"]')!;
    // Landed within a screen before measurement, then exactly on it after.
    expect(Math.abs(el.scrollTop - topOf(u0))).toBeLessThan(VIEWPORT);
    measureRows(() => 48);
    expect(el.scrollTop).toBe(Math.max(0, topOf(u0) - 12));
    // Inside the window: a row a few turns down glides (here: scrolls) there.
    act(() => requestTranscriptJump("s5", 3 * 4 + 1));
    expect(blockIds(container)).toContain("u3");
    measureRows(() => 48);
    const u3 = container.querySelector<HTMLElement>('[data-row="u3"]')!;
    expect(el.scrollTop).toBe(topOf(u3) - 12);
  });

  it("a short log mounts whole, with no Load earlier row", () => {
    const { container, queryByText } = render(
      <AgentTranscript sessionId="s6" blocks={chat(5)} busy={false} visible />,
    );
    // Five prompts, five tool calls, five answers.
    expect(blockIds(container).length).toBe(15);
    expect(queryByText("Load earlier messages")).toBeNull();
  });
});
