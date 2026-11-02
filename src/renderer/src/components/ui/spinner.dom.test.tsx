// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SPINNER_TURN } from "@renderer/lib/ease";
import { Spinner } from "./spinner";

// jsdom has no Web Animations; each turn is a cancellable handle.
const cancel = vi.fn();
const animate = vi.fn((_keyframes: Keyframe[], _timing: KeyframeAnimationOptions) => ({ cancel }) as unknown as Animation);
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

  it("turns as a Web Animation, never a CSS one, and stops when it unmounts", () => {
    const { container, unmount } = render(<Spinner />);
    const svg = container.querySelector("[data-slot=spinner]")!;
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(SPINNER_TURN.keyframes, SPINNER_TURN.timing);
    expect(animate.mock.contexts[0]).toBe(svg);
    expect(svg.hasAttribute("data-turning")).toBe(true);
    expect(svg.getAttribute("class")).not.toMatch(/animate-/);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("holds still when asked, and starts turning when released", () => {
    const { container, rerender } = render(<Spinner still />);
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector("[data-turning]")).toBeNull();
    rerender(<Spinner />);
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(<Spinner still />);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not turn under reduced motion", () => {
    motion(true);
    render(<Spinner />);
    expect(animate).not.toHaveBeenCalled();
  });
});
