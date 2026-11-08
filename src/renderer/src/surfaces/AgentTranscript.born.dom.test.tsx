// @vitest-environment jsdom
/**
 * Which prose rows are born live: a row that joins the live turn after the
 * transcript opened reveals from its first word (`RowBornContext` →
 * AgentMarkdown's `revealFromStart`); a row there at open, a row of a page
 * loaded above, a row scrolled back into view and a person's message show
 * whole. AgentMarkdown is a probe that records what it is handed.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (!this.classList.contains("agent-transcript")) return 0;
    const box = this.querySelector<HTMLElement>(":scope > div:not([data-transcript-outline]) > div");
    return box ? parseFloat(box.style.height) || 0 : 0;
  },
});

import { AgentTranscript } from "./AgentTranscript";
import { setEditorConfigForTest } from "../lib/editorConfig";

const user = (id: string, seq: number): Block => ({ id, role: "user", text: `Ask ${id}`, seq });
const read = (id: string): Block => ({
  id,
  role: "tool",
  text: `Read ${id}`,
  tool: { callId: id, name: "Read", kind: "read", status: "completed", title: `Read ${id}`, input: { file_path: `/repo/${id}.ts` } },
});
const answer = (id: string, seq: number, streaming = false): Block => ({ id, role: "assistant", text: `Answer ${id}`, seq, streaming });

/** `turns` settled chat turns: a prompt, a Read call and an answer. */
function chat(turns: number, from = 0): Block[] {
  const blocks: Block[] = [];
  for (let t = from; t < from + turns; t++) blocks.push(user(`u${t}`, t * 4 + 1), read(`t${t}`), answer(`a${t}`, t * 4 + 4));
  return blocks;
}

const born = (container: HTMLElement, text: string): string | null =>
  container.querySelector<HTMLElement>(`[data-md="${text}"]`)?.dataset.born ?? null;

beforeEach(() => {
  observers.clear();
  setEditorConfigForTest(null);
});
afterEach(cleanup);

describe("AgentTranscript born-live rows", () => {
  it("a prose row that joins the live turn after open reveals from its first word; one there at open does not", () => {
    const open = [user("u0", 1), answer("a0", 2, true)];
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={open} busy visible />);
    expect(born(container, "Answer a0")).toBe("false");
    const later = [user("u0", 1), answer("a0", 2), read("t1"), answer("a1", 4, true)];
    rerender(<AgentTranscript sessionId="s" blocks={later} busy visible />);
    expect(born(container, "Answer a1")).toBe("true");
    expect(born(container, "Answer a0")).toBe("false");
    // It stays born live for the row's life: the stream ending changes nothing.
    rerender(<AgentTranscript sessionId="s" blocks={[...later.slice(0, 3), answer("a1", 4)]} busy={false} visible />);
    expect(born(container, "Answer a1")).toBe("true");
  });

  it("a new turn's reply is born live, the person's message is never handed to the reveal", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={chat(1)} busy={false} visible />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(1), user("u1", 5), answer("a1", 6, true)]} busy visible />);
    expect(born(container, "Answer a1")).toBe("true");
    expect(born(container, "Ask u1")).not.toBe("true");
  });

  it("a page loaded above shows whole", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={chat(1, 1)} busy={false} visible />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(1, 0), ...chat(1, 1)]} busy={false} visible />);
    expect(born(container, "Answer a0")).toBe("false");
    expect(born(container, "Answer a1")).toBe("false");
  });

  it("a turn that settled while the tab was parked shows whole when the reader comes back", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={chat(1)} busy={false} visible />);
    // The reader leaves (the tab parks), the next turn runs and settles meanwhile.
    rerender(<AgentTranscript sessionId="s" blocks={chat(1)} busy={false} visible={false} />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(1), user("u1", 5), answer("a1", 6, true)]} busy visible={false} />);
    rerender(<AgentTranscript sessionId="s" blocks={chat(2)} busy={false} visible={false} />);
    rerender(<AgentTranscript sessionId="s" blocks={chat(2)} busy={false} visible />);
    expect(born(container, "Answer a1")).toBe("false");
    // Nothing of it fades in as a new turn either.
    expect(container.querySelector(`[data-turn="u1"].z-fade-in`)).toBeNull();
  });

  it("a reply still streaming when the reader comes back continues from what arrived", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={chat(1)} busy={false} visible />);
    rerender(<AgentTranscript sessionId="s" blocks={chat(1)} busy={false} visible={false} />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(1), user("u1", 5), answer("a1", 6, true)]} busy visible={false} />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(1), user("u1", 5), answer("a1", 6, true)]} busy visible />);
    expect(born(container, "Answer a1")).toBe("false");
    // A reply that joins after the reader is back is theirs to watch.
    const next = [...chat(1), user("u1", 5), answer("a1", 6), read("t1"), answer("a1b", 8, true)];
    rerender(<AgentTranscript sessionId="s" blocks={next} busy visible />);
    expect(born(container, "Answer a1b")).toBe("true");
  });

  it("rows of the last turn that a page brings in above the tail show whole", () => {
    // A tail-first paint cut inside the last turn: its head lands later, above.
    const tail = [read("t2"), answer("a2b", 12)];
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={tail} busy={false} visible />);
    rerender(<AgentTranscript sessionId="s" blocks={[...chat(2), user("u2", 9), answer("a2", 10), ...tail]} busy={false} visible />);
    expect(born(container, "Answer a2")).toBe("false");
    expect(born(container, "Answer a2b")).toBe("false");
  });

  it("a transcript that mounts before its rows load shows the loaded rows whole", () => {
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={[]} busy={false} visible />);
    rerender(<AgentTranscript sessionId="s" blocks={chat(2)} busy={false} visible />);
    expect(born(container, "Answer a1")).toBe("false");
  });

  it("a born row scrolled out of the window and back shows whole", () => {
    const history = chat(40);
    const { container, rerender } = render(<AgentTranscript sessionId="s" blocks={history} busy visible />);
    const live = [...history, user("u40", 161), answer("a40", 162, true)];
    rerender(<AgentTranscript sessionId="s" blocks={live} busy visible />);
    expect(born(container, "Answer a40")).toBe("true");
    const el = container.querySelector(".agent-transcript") as HTMLDivElement;
    const scroll = (top: number) =>
      act(() => {
        fireEvent.wheel(el, { deltaY: -120 });
        el.scrollTop = top;
        fireEvent.scroll(el);
      });
    scroll(0);
    expect(born(container, "Answer a40")).toBeNull();
    scroll(el.scrollHeight);
    expect(born(container, "Answer a40")).toBe("false");
  });
});
