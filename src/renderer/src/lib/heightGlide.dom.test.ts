// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUR, SPRING_LAYOUT_CSS } from "./ease";
import { glideHeight, isGliding, useHeightGlide } from "./heightGlide";

/** A box whose natural height and drawn (presentation) height the test sets. */
function makeBox(natural: number): { box: HTMLElement; set: (h: number) => void; present: (h: number) => void } {
  const box = document.createElement("div");
  document.body.append(box);
  let height = natural;
  let presented: number | null = null;
  Object.defineProperty(box, "offsetHeight", { configurable: true, get: () => height });
  Object.defineProperty(box, "offsetParent", { configurable: true, get: () => document.body });
  box.getBoundingClientRect = () => ({ height: presented ?? height }) as DOMRect;
  return {
    box,
    set: (h) => {
      height = h;
    },
    present: (h) => {
      presented = h;
    },
  };
}

/** Records every write to the box's inline height. */
function recordHeights(box: HTMLElement): string[] {
  const writes: string[] = [];
  const style = box.style;
  let proto: object | null = Object.getPrototypeOf(style);
  let desc: PropertyDescriptor | undefined;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, "height");
    proto = Object.getPrototypeOf(proto);
  }
  Object.defineProperty(style, "height", {
    configurable: true,
    get: () => desc?.get?.call(style),
    set: (v: string) => {
      writes.push(v);
      desc?.set?.call(style, v);
    },
  });
  return writes;
}

let reduced = false;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  reduced = false;
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes("reduce") })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("glideHeight", () => {
  it("glides from the height it was drawn at to the natural height, on the curve's tokens", () => {
    const { box, set } = makeBox(96);
    set(128);
    expect(glideHeight(box, "layout", 96)).toBe(128);
    expect(box.style.height).toBe("128px");
    expect(box.style.transition).toBe("height var(--dur-layout) var(--ease-layout)");
    expect(box.dataset.heightGlide).toBe("");
    expect(isGliding(box)).toBe(true);
  });

  it("uses the short ease for the base curve", () => {
    const { box, set } = makeBox(20);
    set(40);
    glideHeight(box, "base", 20);
    expect(box.style.transition).toBe("height var(--dur-base) var(--ease-out)");
  });

  it("retargets mid-glide from the height on screen, not the old start", () => {
    const { box, set, present } = makeBox(96);
    set(128);
    glideHeight(box, "layout", 96);
    present(110);
    set(160);
    const writes = recordHeights(box);
    glideHeight(box, "layout", 128);
    expect(writes).toEqual(["", "110px", "160px"]);
  });

  it("does nothing under a pixel, under reduced motion, or for a box with no layout", () => {
    const a = makeBox(96);
    expect(glideHeight(a.box, "layout", 96.5)).toBe(96);
    expect(isGliding(a.box)).toBe(false);

    reduced = true;
    const b = makeBox(96);
    b.set(128);
    glideHeight(b.box, "layout", 96);
    expect(isGliding(b.box)).toBe(false);
    expect(b.box.style.height).toBe("");
    reduced = false;

    const c = makeBox(96);
    Object.defineProperty(c.box, "offsetParent", { get: () => null });
    c.set(128);
    glideHeight(c.box, "layout", 96);
    expect(isGliding(c.box)).toBe(false);
  });

  it("ends on its own height's transitionend and ignores a row's that bubbles up", () => {
    const { box, set } = makeBox(96);
    const row = document.createElement("div");
    box.append(row);
    set(128);
    glideHeight(box, "layout", 96);
    const bubbled = new Event("transitionend", { bubbles: true }) as TransitionEvent;
    Object.defineProperty(bubbled, "propertyName", { value: "height" });
    row.dispatchEvent(bubbled);
    expect(isGliding(box)).toBe(true);
    const opacity = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(opacity, "propertyName", { value: "opacity" });
    box.dispatchEvent(opacity);
    expect(isGliding(box)).toBe(true);
    const own = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(own, "propertyName", { value: "height" });
    box.dispatchEvent(own);
    expect(isGliding(box)).toBe(false);
    expect(box.style.height).toBe("");
    expect(box.style.transition).toBe("");
    expect(box.dataset.heightGlide).toBeUndefined();
  });

  it("ends past the curve's time when no transitionend comes", () => {
    vi.useFakeTimers();
    const layout = makeBox(96);
    layout.set(128);
    glideHeight(layout.box, "layout", 96);
    vi.advanceTimersByTime(SPRING_LAYOUT_CSS.ms + 49);
    expect(isGliding(layout.box)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isGliding(layout.box)).toBe(false);

    const base = makeBox(20);
    base.set(40);
    glideHeight(base.box, "base", 20);
    vi.advanceTimersByTime(DUR.base * 1000 + 50);
    expect(isGliding(base.box)).toBe(false);
  });
});

describe("useHeightGlide", () => {
  it("moves nothing at mount, glides when the key changes, and ends when disabled", () => {
    const { box, set } = makeBox(96);
    const ref = { current: box };
    const { rerender } = renderHook(({ k, on }) => useHeightGlide(ref, k, { enabled: on, curve: "layout" }), {
      initialProps: { k: "a", on: true },
    });
    expect(isGliding(box)).toBe(false);

    set(128);
    rerender({ k: "a,b", on: true });
    expect(isGliding(box)).toBe(true);
    expect(box.style.height).toBe("128px");

    rerender({ k: "a,b", on: false });
    expect(isGliding(box)).toBe(false);
    expect(box.style.height).toBe("");
  });

  it("glides from the last drawn height, and a change while disabled glides nothing", () => {
    const { box, set } = makeBox(96);
    const ref = { current: box };
    const { rerender } = renderHook(({ k, on }) => useHeightGlide(ref, k, { enabled: on, curve: "base" }), {
      initialProps: { k: 1, on: false },
    });
    set(116);
    rerender({ k: 2, on: false });
    expect(isGliding(box)).toBe(false);

    set(136);
    const writes = recordHeights(box);
    rerender({ k: 3, on: true });
    expect(writes).toContain("116px");
    expect(box.style.height).toBe("136px");
  });

  it("does not glide when the key stays the same, whatever the height did", () => {
    const { box, set } = makeBox(96);
    const ref = { current: box };
    const { rerender } = renderHook(({ k }) => useHeightGlide(ref, k, { enabled: true, curve: "layout" }), {
      initialProps: { k: "a" },
    });
    set(200);
    rerender({ k: "a" });
    expect(isGliding(box)).toBe(false);
  });

  it("glides nothing in a commit that changes its hold, and glides again after", () => {
    const { box, set } = makeBox(96);
    const ref = { current: box };
    const { rerender } = renderHook(({ k, hold }) => useHeightGlide(ref, k, { enabled: true, curve: "layout", hold }), {
      initialProps: { k: "a", hold: "closed" },
    });
    set(128);
    rerender({ k: "a,b", hold: "open" });
    expect(isGliding(box)).toBe(false);
    set(160);
    rerender({ k: "a,b,c", hold: "open" });
    expect(isGliding(box)).toBe(true);
  });
});
