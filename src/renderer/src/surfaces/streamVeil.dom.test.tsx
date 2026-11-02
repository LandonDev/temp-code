// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamVeil } from "./streamVeil";

/** jsdom lays nothing out and has no Web Animations: each range gets one
 *  rect, each cover's fade is a handle the test can see finish. */
type FakeAnimation = { playbackRate: number; finished: boolean; onfinish: (() => void) | null; oncancel: (() => void) | null; finish: () => void };
let animations: FakeAnimation[] = [];
let resize: ((entries: { contentRect: { width: number } }[]) => void) | null = null;

beforeEach(() => {
  animations = [];
  resize = null;
  Range.prototype.getClientRects = function () {
    return [{ left: 0, top: 0, width: 40, height: 20 }] as unknown as DOMRectList;
  };
  HTMLElement.prototype.animate = function () {
    const anim: FakeAnimation = {
      playbackRate: 1,
      finished: false,
      onfinish: null,
      oncancel: null,
      finish() {
        this.finished = true;
        this.onfinish?.();
      },
    };
    animations.push(anim);
    return anim as unknown as Animation;
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: typeof resize) {
        resize = cb;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  getSelection()?.removeAllRanges();
});

function Host({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useStreamVeil(ref, text, true);
  return (
    <div ref={ref} data-host>
      <p>{text}</p>
    </div>
  );
}
const covers = (c: HTMLElement) => c.querySelectorAll("[data-host] > div");

describe("the streaming veil", () => {
  it("covers the new words and finishes every fade when the host's width changes", () => {
    const { container, rerender } = render(<Host text="Hello" />);
    rerender(<Host text="Hello world" />);
    expect(covers(container)).toHaveLength(1);
    expect(resize).not.toBeNull();
    // The same width again: nothing moved, the fade goes on.
    act(() => resize!([{ contentRect: { width: 0 } }]));
    expect(covers(container)).toHaveLength(1);
    // A reflow: the covers would sit over the wrong glyphs, so they go at once.
    act(() => resize!([{ contentRect: { width: 320 } }]));
    expect(animations.every((a) => a.finished)).toBe(true);
    expect(covers(container)).toHaveLength(0);
    // With nothing fading, nothing watches.
    expect(resize).toBeNull();
  });

  it("finishes the running fades when a rewrite moves text already shown", () => {
    const { container, rerender } = render(<Host text="Hello" />);
    rerender(<Host text="Hello world" />);
    expect(covers(container)).toHaveLength(1);
    rerender(<Host text="Hullo world and more" />);
    expect(animations[0].finished).toBe(true);
    // Only the changed tail is veiled again.
    expect(covers(container)).toHaveLength(1);
  });

  it("paints no cover while the person holds a selection in the row", () => {
    const { container, rerender } = render(<Host text="Hello" />);
    const range = document.createRange();
    range.selectNodeContents(container.querySelector("p")!);
    getSelection()!.addRange(range);
    rerender(<Host text="Hello world" />);
    expect(covers(container)).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });
});
