// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { SwapIcon } from "./IconSwap";

afterEach(() => {
  cleanup();
  reduced.value = false;
});

const glyphs = (container: HTMLElement) => [...container.querySelectorAll("[data-glyph]")].map((el) => el.getAttribute("data-glyph"));

const swap = (swapped: boolean) => <SwapIcon swapped={swapped} from={<i data-glyph="copy" />} to={<i data-glyph="check" />} />;

describe("SwapIcon", () => {
  it("shows one glyph at rest, with no entrance on first render", () => {
    const view = render(swap(false));
    expect(glyphs(view.container)).toEqual(["copy"]);
    const span = view.container.firstElementChild as HTMLElement;
    expect(span.style.opacity).not.toBe("0");
  });

  it("keeps the old glyph through its exit, then removes it", async () => {
    const view = render(swap(false));
    view.rerender(swap(true));
    expect(glyphs(view.container)).toEqual(["copy", "check"]);
    // jsdom paints no frames: let Motion finish the exit at once.
    MotionGlobalConfig.skipAnimations = true;
    view.rerender(swap(false));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    MotionGlobalConfig.skipAnimations = false;
    expect(glyphs(view.container)).toEqual(["copy"]);
  });

  it("under reduced motion cross-fades with no scale or blur", () => {
    reduced.value = true;
    const view = render(swap(false));
    view.rerender(swap(true));
    const entering = view.container.querySelector("[data-glyph=check]")!.parentElement as HTMLElement;
    expect(entering.style.transform).toBe("");
    expect(entering.style.filter).toBe("");
    expect(entering.style.opacity).toBe("0");
  });
});
