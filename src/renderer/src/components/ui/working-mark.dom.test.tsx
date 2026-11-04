// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";
import { MARK } from "../../lib/ease";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { WorkingMark } from "./working-mark";

// jsdom has no Web Animations: each one is a handle that records its start.
const handles: { cancel: ReturnType<typeof vi.fn>; startTime: number | null }[] = [];
const animate = vi.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => {
  const handle = { cancel: vi.fn(), startTime: null };
  handles.push(handle);
  return handle as unknown as Animation;
});
const hidden = { value: false };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  reduced.value = false;
  hidden.value = false;
  handles.length = 0;
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.clearAllMocks();
});

const dots = (container: HTMLElement) => [...container.querySelectorAll("[data-slot=working-mark] > span")] as HTMLElement[];

describe("WorkingMark", () => {
  it("draws three dots in the working tone, hidden from assistive tech", () => {
    const { container } = render(<WorkingMark />);
    const mark = container.querySelector("[data-slot=working-mark]") as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.className).toContain("size-3.5");
    expect(dots(container)).toHaveLength(3);
    expect(dots(container).map((d) => d.style.transform)).toEqual(["translateX(-4.5px) scale(1)", "scale(1)", "translateX(4.5px) scale(1)"]);
  });

  it("moves each dot by one transform animation on MARK's timing, all from 0 on the document timeline", () => {
    const { container } = render(<WorkingMark />);
    expect(animate).toHaveBeenCalledTimes(3);
    dots(container).forEach((dot, i) => {
      expect(animate.mock.contexts[i]).toBe(dot);
      expect(animate.mock.calls[i]).toEqual([MARK.dots[i], MARK.timing]);
    });
    expect(handles.map((h) => h.startTime)).toEqual([0, 0, 0]);
  });

  it("cancels every animation on unmount", () => {
    const { unmount } = render(<WorkingMark />);
    unmount();
    for (const h of handles) expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("holds still under reduced motion and in a hidden pane", () => {
    reduced.value = true;
    render(<WorkingMark />);
    reduced.value = false;
    render(
      <PaneVisibilityContext.Provider value={false}>
        <WorkingMark />
      </PaneVisibilityContext.Provider>,
    );
    expect(animate).not.toHaveBeenCalled();
  });

  it("rests while the document is hidden and moves again when it shows", () => {
    render(<WorkingMark />);
    expect(animate).toHaveBeenCalledTimes(3);
    act(() => {
      hidden.value = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    for (const h of handles) expect(h.cancel).toHaveBeenCalled();
    act(() => {
      hidden.value = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animate).toHaveBeenCalledTimes(6);
  });
});
