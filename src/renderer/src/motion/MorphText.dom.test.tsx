// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUR, EASE_SWAP_CSS } from "../lib/ease";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reduced.value };
});

import { MorphText } from "./MorphText";

// jsdom lays nothing out and runs no Web Animations: the box is 7px a
// character, and every glide is a cancellable handle.
const cancel = vi.fn();
const animate = vi.fn((_frames: Keyframe[], _timing: KeyframeAnimationOptions) => ({ cancel }) as unknown as Animation);
const rect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return { width: (this.textContent ?? "").length * 7, height: 20, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  reduced.value = false;
  MotionGlobalConfig.skipAnimations = false;
  delete (Element.prototype as { animate?: unknown }).animate;
  Element.prototype.getBoundingClientRect = rect;
  vi.clearAllMocks();
});

const keys = (container: HTMLElement) => [...container.querySelectorAll("[data-morph-key]")].map((el) => el.getAttribute("data-morph-key"));
const box = (container: HTMLElement) => container.querySelector("[data-slot=morph-text]") as HTMLElement;
// jsdom paints no frames: let Motion finish an exit at once.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe("MorphText", () => {
  it("shows its words at rest with nothing moving on mount", () => {
    const view = render(<MorphText state="working">Reading</MorphText>);
    const span = view.container.querySelector("[data-morph-key]") as HTMLElement;
    expect(span.textContent).toBe("Reading");
    expect(span.style.opacity).not.toBe("0");
    expect(span.style.transform).not.toContain("3px");
    expect(animate).not.toHaveBeenCalled();
  });

  it("draws new text under the same state at once, in the same element", () => {
    const view = render(<MorphText state="working">Read 2 files</MorphText>);
    const span = view.container.querySelector("[data-morph-key]");
    view.rerender(<MorphText state="working">Read 3 files</MorphText>);
    expect(view.container.querySelector("[data-morph-key]")).toBe(span);
    expect(span?.textContent).toBe("Read 3 files");
  });

  it("lets the old words leave before the new arrive: never two at once", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<MorphText state="working">Reading</MorphText>);
    view.rerender(<MorphText state="settled">Read</MorphText>);
    expect(keys(view.container)).toEqual(["working"]);
    await settle();
    expect(keys(view.container)).toEqual(["settled"]);
    expect(view.container.textContent).toBe("Read");
  });

  it("keeps only the newest words when the state changes again mid-morph", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<MorphText state="a">Thinking</MorphText>);
    view.rerender(<MorphText state="b">Reading</MorphText>);
    view.rerender(<MorphText state="c">Reading format.ts</MorphText>);
    expect(keys(view.container)).toHaveLength(1);
    await settle();
    expect(keys(view.container)).toEqual(["c"]);
  });

  it("holds the box at the old width while the old words leave, then glides it to the new", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<MorphText state="a">Reading</MorphText>);
    view.rerender(<MorphText state="b">Reading format.ts</MorphText>);
    expect(box(view.container).style.width).toBe("49px");
    await settle();
    expect(box(view.container).style.width).toBe("");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(box(view.container));
    expect(animate).toHaveBeenCalledWith([{ width: "49px" }, { width: "119px" }], { duration: DUR.base * 1000, easing: EASE_SWAP_CSS });
  });

  it("cancels a glide that is cut short and starts the next from the live width", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<MorphText state="a">Reading</MorphText>);
    view.rerender(<MorphText state="b">Reading format.ts</MorphText>);
    await settle();
    view.rerender(<MorphText state="c">Read</MorphText>);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(box(view.container).style.width).toBe("119px");
    await settle();
    expect(animate).toHaveBeenLastCalledWith([{ width: "119px" }, { width: "28px" }], expect.anything());
  });

  it("under reduced motion fades out then in, with no movement and no glide", async () => {
    reduced.value = true;
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<MorphText state="a">Reading</MorphText>);
    view.rerender(<MorphText state="b">Read</MorphText>);
    expect(keys(view.container)).toEqual(["a"]);
    await settle();
    const entering = view.container.querySelector("[data-morph-key=b]") as HTMLElement;
    expect(entering.style.transform).toBe("");
    expect(animate).not.toHaveBeenCalled();
  });
});
