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
let reducedMotion = true;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reducedMotion,
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
/** The pane's width; 0 (the message list hidden) unless a test sets it. */
let paneWidth = 0;
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("agent-transcript") ? paneWidth : 0;
  },
});
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
    // The rows' container alone: the message list's wrapper has no height.
    const box = this.querySelector<HTMLElement>(":scope > div:not([data-transcript-outline]) > div");
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
const boxOf = (container: HTMLElement) =>
  scrollerOf(container).querySelector(":scope > div:not([data-transcript-outline]) > div") as HTMLDivElement;
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

beforeEach(() => {
  observers.clear();
  paneWidth = 0;
  reducedMotion = true;
});
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

describe("AgentTranscript message list", () => {
  const listOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('nav[aria-label="Your messages"]');
  const entries = (container: HTMLElement) => [...listOf(container)!.querySelectorAll<HTMLButtonElement>("button")];
  const entry = (container: HTMLElement, text: string) => entries(container).find((b) => b.textContent === text)!;
  const current = (container: HTMLElement) =>
    entries(container).find((b) => b.getAttribute("aria-current") === "location")?.textContent;
  /** The pane resized: the scroller's observer runs. */
  const resizePane = (container: HTMLElement, width: number) => {
    paneWidth = width;
    const el = scrollerOf(container);
    for (const { callback, targets } of observers) {
      if (targets.has(el)) act(() => callback([]));
    }
  };

  it("hides with one message, and under 864px", () => {
    paneWidth = 1400;
    const one = render(<AgentTranscript sessionId="m1" blocks={chat(1)} busy={false} visible />);
    expect(listOf(one.container)).toBeNull();
    one.unmount();
    paneWidth = 800;
    const { container } = render(<AgentTranscript sessionId="m2" blocks={chat(2)} busy={false} visible />);
    expect(listOf(container)).toBeNull();
    expect(boxOf(container).className).toContain("mx-auto");
  });

  it("sits in the gutter at 1400px with the column centred", () => {
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m3" blocks={chat(2)} busy={false} visible />);
    expect(entries(container).map((b) => b.textContent)).toEqual(["Turn 1", "Turn 2"]);
    expect(boxOf(container).className).toContain("mx-auto");
    expect(boxOf(container).className).toContain("max-w-4xl");
    expect((boxOf(container).parentElement as HTMLElement).style.paddingLeft).toBe("");
  });

  it("moves the column beside it at 1000px, and back as the pane widens", () => {
    paneWidth = 1000;
    const { container } = render(<AgentTranscript sessionId="m4" blocks={chat(2)} busy={false} visible />);
    expect(listOf(container)).not.toBeNull();
    expect(boxOf(container).className).toContain("mr-auto");
    expect(boxOf(container).className).not.toContain("mx-auto");
    expect((boxOf(container).parentElement as HTMLElement).style.paddingLeft).toBe("248px");
    resizePane(container, 1500);
    expect(boxOf(container).className).toContain("mx-auto");
    resizePane(container, 700);
    expect(listOf(container)).toBeNull();
  });

  it("is the scroller's zero-height child, so a wheel over it reaches the scroller", () => {
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m5" blocks={chat(30)} busy={false} visible />);
    const el = scrollerOf(container);
    const wrapper = listOf(container)!.parentElement!;
    expect(wrapper.parentElement).toBe(el);
    expect(wrapper.className).toContain("sticky");
    expect(wrapper.className).toContain("h-0");
    expect(el.scrollHeight).toBe(parseFloat(boxOf(container).style.height));
    expect(el.dataset.scrollMode).toBe("follow");
    act(() => {
      fireEvent.wheel(entry(container, "Turn 3"), { deltaY: -120 });
    });
    expect(el.dataset.scrollMode).toBe("free");
  });

  it("counts a steer whispered into the running turn as a message", () => {
    paneWidth = 1400;
    const blocks: Block[] = [
      ...chat(2),
      { id: "u2", role: "user", text: "Turn 3" },
      { id: "a2", role: "assistant", text: "Working on it" },
      { id: "steer", role: "user", text: "also check the rail" },
    ];
    const { container } = render(<AgentTranscript sessionId="m6" blocks={blocks} busy visible />);
    expect(entries(container).map((b) => b.textContent)).toEqual(["Turn 1", "Turn 2", "Turn 3", "also check the rail"]);
  });

  it("marks the message being read as the reader scrolls", () => {
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m7" blocks={chat(200)} busy={false} visible />);
    const el = scrollerOf(container);
    expect(current(container)).toBe("Turn 200");
    scrollTo(el, 0);
    expect(current(container)).toBe("Turn 1");
    // Mid-thread: the turn of the row a third of the way down the viewport.
    scrollTo(el, parseFloat(boxOf(container).style.height) / 2);
    // The last row starting at or above that line (a zero-height closing row
    // gives way to the turn that starts where it does).
    const y = el.scrollTop + VIEWPORT / 3;
    const reading = [...container.querySelectorAll<HTMLElement>("[data-row]")]
      .filter((row) => topOf(row) <= y)
      .at(-1)!.dataset.turn!;
    expect(current(container)).toBe(`Turn ${Number(reading.slice(1)) + 1}`);
  });

  it("a click on a message far off lands on its row once measured", () => {
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m8" blocks={chat(500)} busy={false} visible />);
    const el = scrollerOf(container);
    act(() => {
      fireEvent.click(entry(container, "Turn 1"));
    });
    expect(blockIds(container)).toContain("u0");
    measureRows(() => 48);
    const u0 = container.querySelector<HTMLElement>('[data-row="u0"]')!;
    expect(el.scrollTop).toBe(Math.max(0, topOf(u0) - 12));
    act(() => {
      fireEvent.click(entry(container, "Turn 5"));
    });
    measureRows(() => 48);
    const u4 = container.querySelector<HTMLElement>('[data-row="u4"]')!;
    expect(el.scrollTop).toBe(topOf(u4) - 12);
  });

  it("Enter lands at once where a click glides", () => {
    reducedMotion = false;
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m9" blocks={chat(500)} busy={false} visible />);
    const el = scrollerOf(container);
    // A click with motion on: the glide starts 2.5 screens short and moves on later frames.
    act(() => {
      fireEvent.click(entry(container, "Turn 1"));
    });
    expect(el.scrollTop).toBe(2.5 * VIEWPORT);
    // Enter: the offset is written now, and the row lands exactly once measured.
    act(() => {
      fireEvent.keyDown(entry(container, "Turn 3"), { key: "Enter" });
    });
    const u2 = container.querySelector<HTMLElement>('[data-row="u2"]')!;
    expect(el.scrollTop).toBe(topOf(u2) - 12);
    measureRows(() => 48);
    expect(el.scrollTop).toBe(topOf(u2) - 12);
  });

  it("keeps the reader's row in place when the column moves beside the list", () => {
    paneWidth = 1400;
    const { container } = render(<AgentTranscript sessionId="m10" blocks={chat(200)} busy={false} visible />);
    const el = scrollerOf(container);
    scrollTo(el, parseFloat(boxOf(container).style.height) / 2);
    const anchor = anchorKeyOf(container, el.scrollTop);
    const onScreen = topOf(container.querySelector<HTMLElement>(`[data-row="${anchor}"]`)!) - el.scrollTop;
    resizePane(container, 1000);
    expect(boxOf(container).className).toContain("mr-auto");
    const again = container.querySelector<HTMLElement>(`[data-row="${anchor}"]`)!;
    expect(topOf(again) - el.scrollTop).toBeCloseTo(onScreen, 0);
  });
});

describe("AgentTranscript scrollbar drag", () => {
  /** A press at `offsetX` on the scroller, whose content box is 790px wide:
   *  past it is the scrollbar's strip, which now takes width on every platform. */
  const press = (el: HTMLElement, offsetX: number) => {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 790 });
    const event = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(event, "offsetX", { value: offsetX });
    act(() => {
      el.dispatchEvent(event);
    });
  };
  const scrollWithoutWheel = (el: HTMLElement, top: number) =>
    act(() => {
      el.scrollTop = top;
      fireEvent.scroll(el);
    });

  it("keeps a stable gutter, so a thread's first overflow never shifts the column", () => {
    const { container } = render(<AgentTranscript sessionId="d0" blocks={chat(5)} busy={false} visible />);
    expect(scrollerOf(container).className).toContain("[scrollbar-gutter:stable]");
  });

  it("a press on the scrollbar's strip marks a drag, and its scroll releases follow", () => {
    const { container } = render(<AgentTranscript sessionId="d1" blocks={chat(200)} busy visible />);
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    press(el, 795);
    scrollWithoutWheel(el, total / 2);
    expect(el.dataset.scrollMode).toBe("free");
  });

  it("a press inside the content is no drag: a scroll there leaves follow alone", () => {
    const { container } = render(<AgentTranscript sessionId="d2" blocks={chat(200)} busy visible />);
    const el = scrollerOf(container);
    const total = parseFloat(boxOf(container).style.height);
    press(el, 400);
    scrollWithoutWheel(el, total / 2);
    expect(el.dataset.scrollMode).not.toBe("free");
  });

  it("a wheel releases follow as before", () => {
    const { container } = render(<AgentTranscript sessionId="d3" blocks={chat(200)} busy visible />);
    const el = scrollerOf(container);
    act(() => {
      fireEvent.wheel(el, { deltaY: -120 });
    });
    expect(el.dataset.scrollMode).toBe("free");
  });
});
