// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeldPhase, useHeldWord, WORD_HOLD_MS } from "./heldWord";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const held = (first: string) =>
  renderHook(({ word }) => useHeldWord(word), { initialProps: { word: first } });

describe("useHeldWord", () => {
  it("a painted word stays 300 ms, then the next one shows", () => {
    expect(WORD_HOLD_MS).toBe(300);
    const view = held("Sending");
    view.rerender({ word: "Starting the CLI" });
    expect(view.result.current).toBe("Sending");
    act(() => vi.advanceTimersByTime(299));
    expect(view.result.current).toBe("Sending");
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current).toBe("Starting the CLI");
  });

  it("a word past its hold gives way at once", () => {
    const view = held("Sending");
    act(() => vi.advanceTimersByTime(1_000));
    view.rerender({ word: "Thinking" });
    expect(view.result.current).toBe("Thinking");
  });

  it("a word that came and went inside the hold is skipped; the latest wins", () => {
    const view = held("Sending");
    view.rerender({ word: "Initializing" });
    act(() => vi.advanceTimersByTime(100));
    view.rerender({ word: "Waiting for the provider" });
    act(() => vi.advanceTimersByTime(100));
    view.rerender({ word: "Thinking" });
    act(() => vi.advanceTimersByTime(100));
    expect(view.result.current).toBe("Thinking");
    // Back to the shown word inside the hold: nothing changes at all.
    const again = held("Thinking");
    again.rerender({ word: "Retrying" });
    act(() => vi.advanceTimersByTime(50));
    again.rerender({ word: "Thinking" });
    act(() => vi.advanceTimersByTime(1_000));
    expect(again.result.current).toBe("Thinking");
  });

  it("the new word holds 300 ms in its turn", () => {
    const view = held("Sending");
    act(() => vi.advanceTimersByTime(400));
    view.rerender({ word: "Starting the CLI" });
    expect(view.result.current).toBe("Starting the CLI");
    act(() => vi.advanceTimersByTime(10));
    view.rerender({ word: "Thinking" });
    act(() => vi.advanceTimersByTime(289));
    expect(view.result.current).toBe("Starting the CLI");
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current).toBe("Thinking");
  });
});

describe("useHeldPhase", () => {
  type Phase = { key: string; words: string };
  const same = (a: Phase, b: Phase) => a.key === b.key && a.words === b.words;
  const phase = (first: Phase) =>
    renderHook(({ p }) => useHeldPhase(p, same), { initialProps: { p: first } });

  it("never shows a phase that lasted 40 ms", () => {
    const view = phase({ key: "thinking", words: "Thinking" });
    view.rerender({ p: { key: "call:a", words: "Reading a.ts" } });
    act(() => vi.advanceTimersByTime(40));
    view.rerender({ p: { key: "thinking", words: "Thinking" } });
    act(() => vi.advanceTimersByTime(1_000));
    expect(view.result.current.key).toBe("thinking");
  });

  it("holds the old phase, with its own words, while a new key waits", () => {
    const view = phase({ key: "host:Waiting", words: "Waiting for the provider, 25 s" });
    view.rerender({ p: { key: "thinking", words: "Thinking" } });
    expect(view.result.current.words).toBe("Waiting for the provider, 25 s");
    act(() => vi.advanceTimersByTime(300));
    expect(view.result.current.words).toBe("Thinking");
  });

  it("takes new words under the same key at once", () => {
    const view = phase({ key: "host:Waiting", words: "Waiting for the provider, 25 s" });
    view.rerender({ p: { key: "host:Waiting", words: "Waiting for the provider, 30 s" } });
    expect(view.result.current.words).toBe("Waiting for the provider, 30 s");
  });
});
