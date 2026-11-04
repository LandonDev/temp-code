// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SPINNER_TURN } from "@renderer/lib/ease";
import { Spinner } from "./spinner";

// jsdom has no Web Animations; each turn is a cancellable handle.
const cancel = vi.fn();
const turns: { startTime: number | null }[] = [];
const animate = vi.fn((_keyframes: Keyframe[], _timing: KeyframeAnimationOptions) => {
  const turn = { cancel, startTime: null as number | null };
  turns.push(turn);
  return turn as unknown as Animation;
});
const motion = (reduce: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }) as MediaQueryList);

describe("Spinner", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    motion(false);
  });
  afterEach(() => {
    cleanup();
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("turns its HTML box as a Web Animation, never the svg or a CSS animation, and stops when it unmounts", () => {
    const { container, unmount } = render(<Spinner className="size-3" />);
    const box = container.querySelector("[data-slot=spinner]")!;
    expect(box.tagName).toBe("SPAN");
    expect(box.className).toContain("size-3");
    expect(box.querySelector("svg")?.getAttribute("class")).toBe("size-full");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(SPINNER_TURN.keyframes, SPINNER_TURN.timing);
    expect(animate.mock.contexts[0]).toBe(box);
    expect(box.hasAttribute("data-turning")).toBe(true);
    expect(container.innerHTML).not.toMatch(/animate-/);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not turn under reduced motion", () => {
    motion(true);
    render(<Spinner />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("turns on the document timeline from 0, so every spinner turns in phase and a remount picks the turn up", () => {
    render(
      <>
        <Spinner />
        <Spinner />
      </>,
    );
    expect(turns.slice(-2).map((t) => t.startTime)).toEqual([0, 0]);
  });
});
