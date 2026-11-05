// @vitest-environment jsdom
/**
 * The phrase fade on the real streamdown pipeline (the dom project stubs
 * streamdown out, so this runs in the node project with jsdom per file):
 * each step is a span that keeps its element as the reply grows, and the
 * settle takes the cached tree only once the last step's fade is over.
 */
import "../test/domSetup";

if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({
  highlight: () => Promise.resolve(null),
  highlightCached: () => undefined,
}));

import { REVEAL } from "../lib/ease";
import { AgentMarkdown } from "./AgentMarkdown";

const FAKE = ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] as const;

describe("AgentMarkdown's phrase fade", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** Streams `text` in 6-character deltas every 20 ms. */
  function stream(rerender: (ui: React.ReactElement) => void, from: string, to: string): void {
    for (let n = from.length + 6; ; n += 6) {
      const text = to.slice(0, Math.min(n, to.length));
      act(() => rerender(<AgentMarkdown text={text} streaming />));
      act(() => vi.advanceTimersByTime(20));
      if (text.length >= to.length) break;
    }
  }

  it("fades each step in its own span and keeps the span as the reply grows", () => {
    const view = render(<AgentMarkdown text="" streaming />);
    const words = "The reveal steps through whole words and each step fades in whole while the reply streams on ";
    stream(view.rerender, "", words);
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 3));
    const steps = () => Array.from(view.container.querySelectorAll("[data-reveal-step]"));
    expect(steps().length).toBeGreaterThan(1);
    const first = steps()[0];
    // No partial word on screen while it streams.
    expect(view.container.textContent!.trim().split(/\s+/).every((w) => words.includes(`${w} `))).toBe(true);
    // The 300 ms pause was an underrun: the rest holds for a grown lead, then
    // reveals.
    stream(view.rerender, words, words + "and then some more words arrive here ");
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 10));
    expect(steps()[0]).toBe(first);
    // The first step is older than the fade: no class; the newest fades.
    expect(first.classList.contains("stream-step")).toBe(false);
    expect(steps().at(-1)!.classList.contains("stream-step")).toBe(true);
  });

  it("raises each list item as it is born and keeps every item's element as the list grows and nests", () => {
    const view = render(<AgentMarkdown text="" streaming />);
    const intro = "Here is the plan for the change today.\n\n";
    const list = `${intro}- first item of the list\n- second item of the list\n`;
    stream(view.rerender, "", list);
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 10));
    const items = () => Array.from(view.container.querySelectorAll("li"));
    expect(items()).toHaveLength(2);
    const [first, second] = items();
    // The paragraph never rises; it keeps the word fade.
    expect(view.container.querySelector("p.stream-rise")).toBeNull();
    // A nested item under the second: the old items keep their elements and
    // never rise again; the new one rises.
    act(() => vi.advanceTimersByTime(REVEAL.fadeMs));
    stream(view.rerender, list, `${list}  - a nested point under it\n`);
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 10));
    const now = items();
    expect(now).toHaveLength(3);
    expect(now[0]).toBe(first);
    expect(now[1]).toBe(second);
    expect(first.classList.contains("stream-rise")).toBe(false);
    expect(second.classList.contains("stream-rise")).toBe(false);
    expect(now[2].classList.contains("stream-rise")).toBe(true);
  });

  /** Advances 10 ms at a time until the row shows `text`; the ms it took. */
  function until(container: HTMLElement, text: string, limit = 3000): number {
    for (let ms = 0; ms <= limit; ms += 10) {
      if (container.textContent!.includes(text)) return ms;
      act(() => vi.advanceTimersByTime(10));
    }
    throw new Error(`never showed ${JSON.stringify(text)}`);
  }

  it("drains what is in hand when the stream ends, then holds the streaming tree until the last step's fade ends, then settles", () => {
    const view = render(<AgentMarkdown text="" streaming />);
    const text = "A short reply that ends here.";
    stream(view.rerender, "", text);
    act(() => view.rerender(<AgentMarkdown text={text} />));
    // The stream ended with text in hand: it drains on the streaming path.
    expect(view.container.textContent).not.toContain("ends here.");
    expect(until(view.container, "ends here.")).toBeGreaterThan(0);
    expect(view.container.querySelector(".stream-step")).not.toBeNull();
    act(() => vi.advanceTimersByTime(REVEAL.fadeMs - 50));
    expect(view.container.querySelector("[data-reveal-step]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(view.container.querySelector("[data-reveal-step]")).toBeNull();
    expect(view.container.textContent).toContain("A short reply that ends here.");
  });

  it("a row born live that mounts settled still reveals over steps, then settles", () => {
    const text = "A reply that landed whole in one commit, born live in the transcript, which still reveals. ";
    const view = render(<AgentMarkdown text={text} revealFromStart />);
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 2));
    expect(view.container.textContent!.length).toBeGreaterThan(0);
    expect(view.container.textContent!.length).toBeLessThan(text.length);
    expect(view.container.querySelector("[data-reveal-step]")).not.toBeNull();
    until(view.container, "which still reveals.");
    act(() => vi.advanceTimersByTime(REVEAL.fadeMs + 50));
    expect(view.container.querySelector("[data-reveal-step]")).toBeNull();
    expect(view.container.textContent).toContain("which still reveals.");
  });

  it("mounts history without a span", () => {
    const view = render(<AgentMarkdown text="An old reply from history." />);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.container.querySelector("[data-reveal-step]")).toBeNull();
  });
});
