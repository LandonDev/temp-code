// @vitest-environment jsdom
/**
 * A parked pane (its tab behind content-visibility: hidden, `visible`
 * false) reads and writes nothing when its boxes resize: a read there forces
 * the whole hidden subtree's style and layout, and the viewport's custom
 * property restyled every row under it, on every workspace switch. The
 * resize it let pass is caught up when it shows, and the property is written
 * only when its value moves.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));
vi.mock("./AgentMarkdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AgentMarkdown")>()),
  AgentMarkdown: ({ text, revealFromStart }: { text: string; revealFromStart?: boolean }) => (
    <div data-md={text} data-born={String(!!revealFromStart)} />
  ),
}));

type Callback = (entries: ResizeObserverEntry[]) => void;
const observers = new Set<{ callback: Callback; targets: Set<Element> }>();
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
const reads = { scrollHeight: 0 };
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("agent-transcript")) reads.scrollHeight++;
    if (!this.classList.contains("agent-transcript")) return 0;
    const box = this.querySelector<HTMLElement>(":scope > div:not([data-transcript-outline]) > div");
    return box ? parseFloat(box.style.height) || 0 : 0;
  },
});

import { AgentTranscript } from "./AgentTranscript";
import { setEditorConfigForTest } from "../lib/editorConfig";

const user = (id: string, seq: number): Block => ({ id, role: "user", text: `Ask ${id}`, seq });
const answer = (id: string, seq: number): Block => ({ id, role: "assistant", text: `Answer ${id}`, seq });
const chat = (turns: number): Block[] => Array.from({ length: turns }, (_, t) => [user(`u${t}`, t * 2 + 1), answer(`a${t}`, t * 2 + 2)]).flat();
/** The scroller's own observer, as the browser fires it when its boxes resize (a tab parked or shown). */
const resize = (el: Element): void => act(() => {
  for (const o of [...observers]) if (o.targets.has(el)) o.callback([]);
});

beforeEach(() => {
  observers.clear();
  setEditorConfigForTest(null);
});
afterEach(cleanup);

describe("a parked transcript", () => {
  it("reads and writes nothing on a resize or a push while parked, catches the resize up when it shows, and writes the viewport only when it moves", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={chat(10)} busy visible />);
    const el = container.querySelector(".agent-transcript") as HTMLDivElement;
    const writes = vi.spyOn(el.style, "setProperty");
    // Shown and unchanged: the viewport's height reads the same, so nothing is written.
    resize(el);
    expect(writes.mock.calls.filter(([name]) => name === "--transcript-viewport")).toEqual([]);
    // Parked: its resize and its pushes read no layout and write no style.
    rerender(<AgentTranscript sessionId="s" blocks={chat(10)} busy visible={false} />);
    reads.scrollHeight = 0;
    resize(el);
    rerender(<AgentTranscript sessionId="s" blocks={chat(12)} busy visible={false} />);
    expect(reads.scrollHeight).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    // Shown again: the missed resize runs once and the thread lands on its bottom.
    rerender(<AgentTranscript sessionId="s" blocks={chat(12)} busy visible />);
    expect(reads.scrollHeight).toBeGreaterThan(0);
    expect(writes.mock.calls.filter(([name]) => name === "--transcript-viewport")).toEqual([]);
    expect(el.style.getPropertyValue("--transcript-viewport")).toBe("600px");
  });
});
