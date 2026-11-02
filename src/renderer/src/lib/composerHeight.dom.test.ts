// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { morphTextareaHeight } from "./composerHeight";

afterEach(() => vi.restoreAllMocks());

function textarea(height = "40px", content = 120) {
  const el = document.createElement("div");
  el.style.height = height;
  el.style.lineHeight = "22px";
  Object.defineProperty(el, "scrollHeight", { value: content });
  return el;
}

describe("morphTextareaHeight", () => {
  it("snaps on a keystroke, however far the height moves", () => {
    const el = textarea();
    morphTextareaHeight(el, 200);
    expect(el.style.height).toBe("120px");
    expect(el.style.transition).toBe("");
  });

  it("eases a three-line paste over the shared timing until height settles, capped", () => {
    const el = textarea("40px", 120);
    morphTextareaHeight(el, 100, true);
    expect(el.style.height).toBe("100px");
    expect(el.style.transition).toBe("height var(--dur-base) var(--ease-out)");
    const other = new Event("transitionend");
    Object.defineProperty(other, "propertyName", { value: "opacity" });
    el.dispatchEvent(other);
    expect(el.style.transition).not.toBe("");
    const done = new Event("transitionend");
    Object.defineProperty(done, "propertyName", { value: "height" });
    el.dispatchEvent(done);
    expect(el.style.transition).toBe("");
  });

  it("snaps a programmatic change of one line or less", () => {
    const el = textarea("44px", 66);
    morphTextareaHeight(el, 200, true);
    expect(el.style.height).toBe("66px");
    expect(el.style.transition).toBe("");
  });

  it("sets an initial, cleared or unchanged height without a transition", () => {
    for (const height of ["", "auto", "120px"]) {
      const el = textarea(height);
      morphTextareaHeight(el, 200, true);
      expect(el.style.height).toBe("120px");
      expect(el.style.transition).toBe("");
    }
  });

  it("sets the height at once under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const el = textarea();
    morphTextareaHeight(el, 200, true);
    expect(el.style.height).toBe("120px");
    expect(el.style.transition).toBe("");
  });
});
