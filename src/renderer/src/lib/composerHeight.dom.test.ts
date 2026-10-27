// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { morphTextareaHeight } from "./composerHeight";

afterEach(() => vi.restoreAllMocks());

function textarea(height = "40px") {
  const el = document.createElement("div");
  el.style.height = height;
  Object.defineProperty(el, "scrollHeight", { value: 120 });
  return el;
}

describe("morphTextareaHeight", () => {
  it("caps the target height and uses the shared timing until height settles", () => {
    const el = textarea();
    morphTextareaHeight(el, 100);
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

  it("sets an initial or unchanged height without a transition", () => {
    for (const height of ["", "120px"]) {
      const el = textarea(height);
      morphTextareaHeight(el, 200);
      expect(el.style.height).toBe("120px");
      expect(el.style.transition).toBe("");
    }
  });

  it("sets the height at once under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const el = textarea();
    morphTextareaHeight(el, 200);
    expect(el.style.height).toBe("120px");
    expect(el.style.transition).toBe("");
  });
});
