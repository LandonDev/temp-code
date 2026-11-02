// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSmoothText } from "./smoothText";
import { REVEAL } from "../lib/ease";

vi.mock("../hooks/paneVisibility", () => ({ usePaneVisible: () => true }));

function Shown({ text, streaming }: { text: string; streaming: boolean }) {
  return <span>{useSmoothText(text, streaming)}</span>;
}

describe("useSmoothText", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks for a frame when a paint is due, not at every display frame, and still reveals it all", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const { container, rerender } = render(<Shown text="" streaming />);
    let text = "";
    // One second of a stream: a 12-character delta every 50 ms.
    for (let i = 0; i < 20; i++) {
      text += "streamed it ";
      act(() => rerender(<Shown text={text} streaming />));
      act(() => vi.advanceTimersByTime(50));
    }
    // A frame per step (at most every REVEAL.stepMs) and one per delta at
    // most, where a loop on every frame would ask for about 60 here.
    expect(frames.mock.calls.length).toBeLessThanOrEqual(Math.ceil(1000 / REVEAL.stepMs) + 20);
    expect(container.textContent!.length).toBeGreaterThan(0);
    act(() => rerender(<Shown text={text} streaming={false} />));
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toBe(text);
  });

  it("steps whole words about every REVEAL.stepMs", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { container, rerender } = render(<Shown text="" streaming />);
    let text = "";
    const seen: { at: number; text: string }[] = [];
    let at = 0;
    // Two seconds of a 7-character delta every 10 ms, recorded every 10 ms.
    for (let i = 0; i < 200; i++) {
      text += "word ab";
      act(() => rerender(<Shown text={text} streaming />));
      act(() => vi.advanceTimersByTime(10));
      at += 10;
      const now = container.textContent!;
      if (seen.length === 0 || seen[seen.length - 1].text !== now) seen.push({ at, text: now });
    }
    const steps = seen.filter((s) => s.text.length > 0);
    expect(steps.length).toBeGreaterThan(5);
    for (const step of steps) expect(step.text === text || /\s$/.test(step.text)).toBe(true);
    for (let i = 2; i < steps.length; i++) expect(steps[i].at - steps[i - 1].at).toBeGreaterThanOrEqual(REVEAL.stepMs - 20);
  });

  it("keeps pace with deltas that come faster than it paints", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { container, rerender } = render(<Shown text="" streaming />);
    let text = "";
    // Five seconds of 2 characters every 10 ms: each arrival restarts the
    // loop while it waits for its next paint, and must not reset its clock.
    for (let i = 0; i < 500; i++) {
      text += "ab";
      act(() => rerender(<Shown text={text} streaming />));
      act(() => vi.advanceTimersByTime(10));
    }
    // Behind the live end by the pacer's lag alone (at most 500 ms of text).
    expect(container.textContent!.length).toBeGreaterThan(900);
  });
});
