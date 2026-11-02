// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { SwapText } from "./SwapText";

afterEach(() => {
  cleanup();
  reduced.value = false;
});

const words = (container: HTMLElement) => [...container.querySelectorAll("[data-swap-text]")].map((el) => el.textContent);

describe("SwapText", () => {
  it("shows its words at rest with no entrance on mount", () => {
    const view = render(<SwapText state="working">Reading</SwapText>);
    expect(words(view.container)).toEqual(["Reading"]);
    const span = view.container.firstElementChild as HTMLElement;
    expect(span.style.opacity).not.toBe("0");
    expect(span.style.transform).not.toContain("3px");
  });

  it("changes the words in place under one state: a count or a streamed word never animates", () => {
    const view = render(<SwapText state="working">Read 2 files</SwapText>);
    const span = view.container.firstElementChild;
    view.rerender(<SwapText state="working">Read 3 files</SwapText>);
    expect(view.container.firstElementChild).toBe(span);
    expect(words(view.container)).toEqual(["Read 3 files"]);
  });

  it("on a change of state the new words rise 3px from below while the old leave", () => {
    const view = render(<SwapText state="working">Reading</SwapText>);
    view.rerender(<SwapText state="settled">Read</SwapText>);
    expect(words(view.container)).toEqual(["Reading", "Read"]);
    const entering = view.container.querySelector("[data-swap-text=settled]") as HTMLElement;
    expect(entering.style.transform).toContain("translateY(3px)");
    expect(entering.style.opacity).toBe("0");
  });

  it("removes the old words once their exit ends", async () => {
    // jsdom paints no frames: let Motion finish the exit at once.
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<SwapText state="working">Reading</SwapText>);
    view.rerender(<SwapText state="settled">Read</SwapText>);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    MotionGlobalConfig.skipAnimations = false;
    expect(words(view.container)).toEqual(["Read"]);
  });

  it("under reduced motion cross-fades with no movement", () => {
    reduced.value = true;
    const view = render(<SwapText state="working">Reading</SwapText>);
    view.rerender(<SwapText state="settled">Read</SwapText>);
    const entering = view.container.querySelector("[data-swap-text=settled]") as HTMLElement;
    expect(entering.style.transform).toBe("");
    expect(entering.style.opacity).toBe("0");
  });
});
