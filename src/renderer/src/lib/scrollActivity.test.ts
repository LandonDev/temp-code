// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCROLL_IDLE_MS } from "./ease";
import { SCROLLING_ATTR, installScrollActivity } from "./scrollActivity";

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

  it("writes the attribute once per burst", () => {
    const set = vi.spyOn(el, "setAttribute");
    for (let i = 0; i < 20; i++) scroll();
    expect(set).toHaveBeenCalledTimes(1);
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
    scroll();
    expect(el.hasAttribute(SCROLLING_ATTR)).toBe(false);
    uninstall = () => {};
  });
});
