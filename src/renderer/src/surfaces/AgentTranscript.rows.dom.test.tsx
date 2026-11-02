// @vitest-environment jsdom
/**
 * What a streamed delta re-renders: the transcript's rows compare by what
 * they draw (`sameRow`), and a row re-rendered for a moved offset keeps the
 * row it drew, so the views inside it see the same blocks. ActionGroup is
 * replaced by a probe that records the blocks it is handed.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));
const handed: Block[][] = [];
vi.mock("./transcript/ActionGroup", () => ({
  ActionGroup: ({ blocks }: { blocks: Block[] }) => {
    handed.push(blocks);
    return <div data-group={blocks[0]!.id} />;
  },
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

/** Fire a measurement of `height` px for the mounted row `key`. */
function measure(key: string, height: number): void {
  for (const { callback, targets } of observers) {
    const target = [...targets].find((el) => (el as HTMLElement).dataset.row === key);
    if (!target) continue;
    act(() =>
      callback([{ target, contentRect: { height } as DOMRectReadOnly, borderBoxSize: [{ blockSize: height, inlineSize: 800 }] } as unknown as ResizeObserverEntry]),
    );
  }
}

import { AgentTranscript } from "./AgentTranscript";

const read = (id: string): Block => ({
  id,
  role: "tool",
  text: `Read ${id}`,
  tool: { callId: id, name: "Read", kind: "read", status: "completed", title: `Read ${id}`, input: { file_path: `/repo/${id}.ts` } },
});
/** The live turn's blocks; a delta replaces the answer alone, as the fold does. */
const asked: Block[] = [{ id: "u0", role: "user", text: "Look", seq: 1 }, read("t0"), read("t1")];
const turn = (answer: string): Block[] => [...asked, { id: "a0", role: "assistant", text: answer, seq: 4 }];

afterEach(() => {
  cleanup();
  handed.length = 0;
});

describe("AgentTranscript rows under a stream", () => {
  it("re-renders no group for a delta, and hands a moved group the blocks it drew", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={turn("Hel")} busy visible />);
    expect(container.querySelector("[data-group=t0]")).toBeTruthy();
    const drawn = handed.at(-1)!;
    const calls = handed.length;
    // A delta: the turn regroups, so the group's row comes back a new object
    // with a new blocks array; the group does not re-render.
    rerender(<AgentTranscript sessionId="s" blocks={turn("Hello")} busy visible />);
    expect(handed.length).toBe(calls);
    // The bubble above it grows (the window writes the new offsets to the
    // DOM), so at the next delta the group's row renders again for its
    // offset: with the blocks it drew, not the new deltas' arrays.
    measure("u0", 400);
    rerender(<AgentTranscript sessionId="s" blocks={turn("Hello there")} busy visible />);
    expect(handed.length).toBe(calls + 1);
    expect(handed.at(-1)).toBe(drawn);
  });
});
