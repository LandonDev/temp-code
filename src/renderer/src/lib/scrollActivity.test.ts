// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCROLL_IDLE_MS, SCROLL_QUIET_MS } from "./ease";
import { QUIET_ATTR, SCROLLING_ATTR, installScrollActivity } from "./scrollActivity";

describe("installScrollActivity", () => {
  let uninstall: () => void;
  let el: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    uninstall = installScrollActivity(document);
  });

  afterEach(() => {
    uninstall();
    el.remove();
    vi.useRealTimers();
  });

  const scroll = (target: EventTarget = el) => target.dispatchEvent(new Event("scroll"));

  it("marks the element that scrolled", () => {
    scroll();
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
  });

  it("clears the mark SCROLL_IDLE_MS after the last scroll", () => {
    scroll();
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(false);
  });

  it("a second scroll inside the window keeps the mark and pushes the clear back", () => {
    scroll();
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);
    scroll();
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(false);
  });

  it("writes each attribute once per burst", () => {
    const set = vi.spyOn(el, "setAttribute");
    for (let i = 0; i < 20; i++) scroll();
    expect(set.mock.calls.map(([name]) => name)).toEqual([SCROLLING_ATTR, QUIET_ATTR]);
  });

  it("keeps the pointer off the children until SCROLL_QUIET_MS after the last scroll", () => {
    scroll();
    vi.advanceTimersByTime(SCROLL_QUIET_MS - 50);
    scroll();
    vi.advanceTimersByTime(SCROLL_QUIET_MS - 1);
    expect(el.hasAttribute(QUIET_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute(QUIET_ATTR)).toBe(false);
    // The bar's mark outlives it.
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
  });

  it("gives the pointer back at once when the person moves it, not on the browser's own move after a scroll", () => {
    const move = (dx: number) => {
      const event = new MouseEvent("pointermove", { bubbles: true });
      Object.defineProperty(event, "movementX", { value: dx });
      el.dispatchEvent(event);
    };
    scroll();
    move(0);
    expect(el.hasAttribute(QUIET_ATTR)).toBe(true);
    move(3);
    expect(el.hasAttribute(QUIET_ATTR)).toBe(false);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
  });

  it("gives the pointer back on a press and never takes it while a button is held", () => {
    scroll();
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(el.hasAttribute(QUIET_ATTR)).toBe(false);
    // A scrollbar drag, or a selection reaching the edge, scrolls with the button down.
    scroll();
    expect(el.hasAttribute(QUIET_ATTR)).toBe(false);
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(true);
    el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    scroll();
    expect(el.hasAttribute(QUIET_ATTR)).toBe(true);
  });

  it("ignores the document's own scroll", () => {
    scroll(document);
    expect(document.documentElement.hasAttribute(SCROLLING_ATTR)).toBe(false);
    expect(document.body.hasAttribute(SCROLLING_ATTR)).toBe(false);
  });

  it("uninstall stops marking and clears a live mark", () => {
    scroll();
    uninstall();
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(false);
    expect(el.hasAttribute(QUIET_ATTR)).toBe(false);
    scroll();
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(false);
    uninstall = () => {};
  });
});
