// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { easeFieldHeight, settleFieldHeight } from "./composerHeight";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A field whose drawn height is its pinned inline height, else its content's (22px a line, 6px of padding). */
function field(lines = 1) {
  const el = document.createElement("div");
  el.style.lineHeight = "22px";
  const box = { lines };
  const reads = { rect: 0, offset: 0, scroll: 0 };
  el.getBoundingClientRect = () => {
    reads.rect++;
    const pinned = parseFloat(el.style.height);
    return { height: Number.isFinite(pinned) ? pinned : 6 + 22 * box.lines } as DOMRect;
  };
  Object.defineProperty(el, "offsetHeight", { get: () => (reads.offset++, 0) });
  Object.defineProperty(el, "scrollHeight", { get: () => (reads.scroll++, 0) });
  return { el, box, reads };
}

const ended = (el: HTMLElement, propertyName = "height"): void => {
  const event = new Event("transitionend");
  Object.defineProperty(event, "propertyName", { value: propertyName });
  Object.defineProperty(event, "target", { value: el });
  el.dispatchEvent(event);
};

describe("the composer's field sizes itself", () => {
  it("a keystroke with no ease running reads and writes nothing", () => {
    const { el, reads } = field();
    for (let i = 0; i < 50; i++) settleFieldHeight(el);
    expect(reads).toEqual({ rect: 0, offset: 0, scroll: 0 });
    expect(el.getAttribute("style")).toBe("line-height: 22px;");
  });

  it("a three-line paste eases from the old height to the new, then leaves the height to the browser", () => {
    const { el, box } = field(1);
    easeFieldHeight(el, () => (box.lines = 3));
    expect(el.style.height).toBe("72px");
    expect(el.style.transition).toBe("height var(--dur-base) var(--ease-out)");
    // Another property's end, or a child's, is not the height's.
    ended(el, "opacity");
    const child = new Event("transitionend", { bubbles: true });
    Object.defineProperty(child, "propertyName", { value: "height" });
    el.append(document.createElement("span"));
    el.firstElementChild!.dispatchEvent(child);
    expect(el.style.height).toBe("72px");
    ended(el);
    expect(el.style.height).toBe("");
    expect(el.style.transition).toBe("");
  });

  it("a change of one line or less snaps and pins nothing", () => {
    const { el, box } = field(2);
    easeFieldHeight(el, () => (box.lines = 3));
    expect(el.style.height).toBe("");
    expect(el.style.transition).toBe("");
  });

  it("a box with no layout yet snaps", () => {
    const { el, box } = field(1);
    el.getBoundingClientRect = () => ({ height: 0 }) as DOMRect;
    easeFieldHeight(el, () => (box.lines = 5));
    expect(el.style.height).toBe("");
  });

  it("reduced motion snaps", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { el, box } = field(1);
    easeFieldHeight(el, () => (box.lines = 4));
    expect(el.style.height).toBe("");
    expect(el.style.transition).toBe("");
  });

  it("a keystroke mid-ease snaps the box to its content, so a width change later finds nothing pinned", () => {
    const { el, box } = field(1);
    easeFieldHeight(el, () => (box.lines = 4));
    expect(el.style.height).toBe("94px");
    settleFieldHeight(el);
    expect(el.style.height).toBe("");
    expect(el.style.transition).toBe("");
    // The ended ease no longer listens: a late transitionend changes nothing.
    el.style.height = "10px";
    ended(el);
    expect(el.style.height).toBe("10px");
  });

  it("a second change mid-ease starts from where the box is drawn", () => {
    const { el, box } = field(1);
    const seen: number[] = [];
    const rect = el.getBoundingClientRect.bind(el);
    el.getBoundingClientRect = () => {
      const r = rect();
      seen.push(r.height);
      return r;
    };
    easeFieldHeight(el, () => (box.lines = 4));
    // Drawn at 94px now (the pinned target stands in for the transition's value).
    easeFieldHeight(el, () => (box.lines = 1));
    // Before and after each change: 28 → 94, then from the drawn 94 down to 28.
    expect(seen).toEqual([28, 94, 94, 28]);
    expect(el.style.height).toBe("28px");
    expect(el.style.transition).toBe("height var(--dur-base) var(--ease-out)");
    ended(el);
    expect(el.style.height).toBe("");
  });

  it("an ease whose transition never ends still lets go of the height", () => {
    vi.useFakeTimers();
    const { el, box } = field(1);
    easeFieldHeight(el, () => (box.lines = 4));
    expect(el.style.height).toBe("94px");
    vi.advanceTimersByTime(1_000);
    expect(el.style.height).toBe("");
  });
});
