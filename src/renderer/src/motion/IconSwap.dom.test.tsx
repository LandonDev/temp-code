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

  it("keyed: swaps whenever the state changes, through any number of glyphs, in one box", () => {
    const keyed = (state: string) => (
      <SwapIcon state={state}>
        <i data-glyph={state} />
      </SwapIcon>
    );
    const view = render(keyed("waiting"));
    expect(glyphs(view.container)).toEqual(["waiting"]);
    // The same state again: nothing remounts.
    const first = view.container.querySelector("[data-swap]");
    view.rerender(keyed("waiting"));
    expect(view.container.querySelector("[data-swap]")).toBe(first);
    view.rerender(keyed("working"));
    expect(glyphs(view.container)).toEqual(["waiting", "working"]);
    const entering = view.container.querySelector("[data-glyph=working]")!.parentElement as HTMLElement;
    // The entrance is one transform (composited), from a quarter size.
    expect(entering.style.transform).toContain("scale(0.25)");
    expect(entering.style.opacity).toBe("0");
  });

  it("lands the new glyph at full size, never at a zero scale", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const keyed = (state: string) => (
      <SwapIcon state={state}>
        <i data-glyph={state} />
      </SwapIcon>
    );
    const view = render(keyed("working"));
    view.rerender(keyed("icon"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    MotionGlobalConfig.skipAnimations = false;
    const landed = view.container.querySelector("[data-glyph=icon]")!.parentElement as HTMLElement;
    expect(landed.style.transform).not.toMatch(/scale\(0(\.\d+)?\)/);
    expect(landed.style.opacity).toBe("1");
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
