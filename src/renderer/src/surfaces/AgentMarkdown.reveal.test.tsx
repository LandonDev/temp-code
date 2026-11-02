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
    const steps = () => Array.from(view.container.querySelectorAll("[data-step]"));
    expect(steps().length).toBeGreaterThan(1);
    const first = steps()[0];
    // No partial word on screen while it streams.
    expect(view.container.textContent!.trim().split(/\s+/).every((w) => words.includes(`${w} `))).toBe(true);
    stream(view.rerender, words, words + "and then some more words arrive here ");
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 3));
    expect(steps()[0]).toBe(first);
    // The first step is older than the fade: no class; the newest fades.
    expect(first.classList.contains("stream-step")).toBe(false);
    expect(steps().at(-1)!.classList.contains("stream-step")).toBe(true);
  });

  it("holds the streaming tree until the last step's fade ends, then settles", () => {
    const view = render(<AgentMarkdown text="" streaming />);
    const text = "A short reply that ends here.";
    stream(view.rerender, "", text);
    act(() => view.rerender(<AgentMarkdown text={text} />));
    expect(view.container.textContent).toContain("ends here.");
    expect(view.container.querySelector(".stream-step")).not.toBeNull();
    act(() => vi.advanceTimersByTime(REVEAL.fadeMs - 50));
    expect(view.container.querySelector("[data-step]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(view.container.querySelector("[data-step]")).toBeNull();
    expect(view.container.textContent).toContain("A short reply that ends here.");
  });

  it("mounts history without a span", () => {
    const view = render(<AgentMarkdown text="An old reply from history." />);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.container.querySelector("[data-step]")).toBeNull();
  });
});
