// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSmoothText, type SmoothTextOptions } from "./smoothText";
import { REVEAL } from "../lib/ease";

const pane = vi.hoisted(() => ({ visible: true }));
vi.mock("../hooks/paneVisibility", () => ({ usePaneVisible: () => pane.visible }));

const FAKE = ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] as const;

function Shown({ text, streaming, opts }: { text: string; streaming: boolean; opts?: SmoothTextOptions }) {
  return <span>{useSmoothText(text, streaming, opts)}</span>;
}

/** The shown length after each `every` ms until `ms` have passed. */
function watch(container: HTMLElement, ms: number, every = 10): number[] {
  const seen: number[] = [];
  for (let at = 0; at < ms; at += every) {
    act(() => vi.advanceTimersByTime(every));
    seen.push(container.textContent!.length);
  }
  return seen;
}

describe("useSmoothText", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    pane.visible = true;
  });

  it("asks for a frame when a paint is due, not at every display frame, and still reveals it all", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
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

  it("shows a code line once its newline arrives, and a line held REVEAL.lineHoldMs by words", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const head = "```ts\nconst a = 1;\n";
    const { container, rerender } = render(<Shown text={head} streaming opts={{ fromStart: false }} />);
    act(() => vi.advanceTimersByTime(500));
    expect(container.textContent).toBe(head);
    // A long line streams in with no newline: nothing of it shows during the hold.
    let text = head;
    for (const word of ["const ", "answer ", "= ", "compute(", "input, ", "options); "]) {
      text += word;
      act(() => rerender(<Shown text={text} streaming opts={{ fromStart: false }} />));
      act(() => vi.advanceTimersByTime(80));
    }
    expect(container.textContent).toBe(head);
    act(() => vi.advanceTimersByTime(REVEAL.lineHoldMs));
    expect(container.textContent!.length).toBeGreaterThan(head.length);
    // Its newline shows the line whole; the next line holds afresh.
    text += "\nconst ";
    act(() => rerender(<Shown text={text} streaming opts={{ fromStart: false }} />));
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.textContent!.endsWith("options); \n")).toBe(true);
  });

  it("steps whole words about every REVEAL.stepMs", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
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
    vi.useFakeTimers({ toFake: [...FAKE] });
    const { container, rerender } = render(<Shown text="" streaming />);
    let text = "";
    // Five seconds of 2 characters every 10 ms: each arrival restarts the
    // loop while it waits for its next paint, and must not reset its clock.
    for (let i = 0; i < 500; i++) {
      text += "ab";
      act(() => rerender(<Shown text={text} streaming />));
      act(() => vi.advanceTimersByTime(10));
    }
    // Behind the live end by the lead and a step at most.
    expect(container.textContent!.length).toBeGreaterThan(950);
  });

  it("a burst that ends the stream 30 ms later drains over steps, never in one", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const text = "word ".repeat(600); // 3,000 chars
    const { container, rerender } = render(<Shown text="" streaming />);
    act(() => rerender(<Shown text={text} streaming />));
    act(() => vi.advanceTimersByTime(30));
    act(() => rerender(<Shown text={text} streaming={false} />));
    const seen = watch(container, 2_000);
    expect(seen[0]).toBeLessThan(text.length / 5);
    const changes = seen.filter((n, i) => n !== (i === 0 ? 0 : seen[i - 1])).length;
    expect(changes).toBeGreaterThanOrEqual(10);
    let biggest = 0;
    for (let i = 1; i < seen.length; i++) biggest = Math.max(biggest, seen[i] - seen[i - 1]);
    expect(biggest).toBeLessThan(text.length / 5);
    expect(seen.at(-1)).toBe(text.length);
  });

  it("a row born live mounts at nothing and reveals; one mounted without it shows whole", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const text = "A reply whose first commit carried most of it. ".repeat(10);
    const born = render(<Shown text={text} streaming opts={{ fromStart: true }} />);
    expect(born.container.textContent).toBe("");
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 4));
    const midway = born.container.textContent!.length;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(text.length);
    born.unmount();
    expect(render(<Shown text={text} streaming />).container.textContent).toBe(text);
  });

  it("a row born live that mounted already settled still reveals, then shows whole", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const text = "word ".repeat(200);
    const { container } = render(<Shown text={text} streaming={false} opts={{ fromStart: true }} />);
    expect(container.textContent).toBe("");
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 3));
    expect(container.textContent!.length).toBeGreaterThan(0);
    expect(container.textContent!.length).toBeLessThan(text.length);
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toBe(text);
  });

  it("a settled row whose text changes shows the change at once", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const { container, rerender } = render(<Shown text="An old reply" streaming={false} />);
    act(() => rerender(<Shown text="An old reply, edited" streaming={false} />));
    expect(container.textContent).toBe("An old reply, edited");
  });

  it("a rewrite snaps", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const { container, rerender } = render(<Shown text="" streaming />);
    const text = "word ".repeat(100);
    act(() => rerender(<Shown text={text} streaming />));
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 4));
    expect(container.textContent!.length).toBeGreaterThan(0);
    const rewritten = "other ".repeat(100);
    act(() => rerender(<Shown text={rewritten} streaming />));
    expect(container.textContent).toBe(rewritten);
  });

  it("a hidden pane snaps", () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const { container, rerender } = render(<Shown text="" streaming />);
    const text = "word ".repeat(400);
    act(() => rerender(<Shown text={text} streaming />));
    act(() => vi.advanceTimersByTime(REVEAL.stepMs * 3));
    expect(container.textContent!.length).toBeLessThan(text.length);
    pane.visible = false;
    act(() => rerender(<Shown text={text + "more "} streaming />));
    expect(container.textContent).toBe(text + "more ");
  });
});
