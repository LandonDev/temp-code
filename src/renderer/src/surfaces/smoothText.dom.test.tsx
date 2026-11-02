// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { PAINT_EVERY_MS, useSmoothText } from "./smoothText";

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
    // A frame per paint (at most every PAINT_EVERY_MS) and one per delta at
    // most, where a loop on every frame would ask for about 60 here.
    expect(frames.mock.calls.length).toBeLessThanOrEqual(Math.ceil(1000 / PAINT_EVERY_MS) + 20);
    expect(container.textContent!.length).toBeGreaterThan(0);
    act(() => rerender(<Shown text={text} streaming={false} />));
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toBe(text);
  });
});
