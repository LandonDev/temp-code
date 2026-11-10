// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockForTest } from "../../lib/turnClock";
import { ReasoningColumn, ThoughtSeconds } from "./reasoning-steps";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sentences = (c: HTMLElement) => [...c.querySelectorAll("[data-slot=reasoning-column] p span")].map((s) => s.textContent?.trim());

describe("ReasoningColumn", () => {
  it("draws each finished sentence once, by paragraph, on the stream's own fade, and never the one being written", () => {
    const view = render(<ReasoningColumn text="I read the file. Now the te" live />);
    expect(sentences(view.container)).toEqual(["I read the file."]);
    const first = view.container.querySelector("[data-slot=reasoning-column] p span")!;
    expect(first.className).toBe("stream-step");
    view.rerender(<ReasoningColumn text={"I read the file. Now the tests.\n\nThen the"} live />);
    expect(sentences(view.container)).toEqual(["I read the file.", "Now the tests."]);
    expect(view.container.querySelectorAll("[data-slot=reasoning-column] p")).toHaveLength(1);
    // The first sentence is the same element: its fade ran once.
    expect(view.container.querySelector("[data-slot=reasoning-column] p span")).toBe(first);
    view.rerender(<ReasoningColumn text={"I read the file. Now the tests.\n\nThen the build."} live />);
    expect(view.container.querySelectorAll("[data-slot=reasoning-column] p")).toHaveLength(2);
    expect(view.container.querySelector("[data-slot=reasoning-column] p span")).toBe(first);
  });

  it("is a capped column that names its horizontal policy, fades its cut edges, takes focus and is no live region", () => {
    const { container } = render(<ReasoningColumn text="One. Two." live />);
    const column = container.querySelector<HTMLElement>("[data-slot=reasoning-column]")!;
    const classes = column.className.split(/\s+/);
    expect(classes).toContain("max-h-48");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overflow-x-hidden");
    expect(classes).toContain("scrollbar-none");
    expect(classes).toContain("focus-ring");
    expect(classes.some((c) => c.startsWith("[mask-image:"))).toBe(true);
    expect(classes.some((c) => c.startsWith("data-overflow-start:"))).toBe(true);
    expect(column.className).toContain("text-sm leading-[22px] text-muted-foreground");
    expect(column.getAttribute("tabindex")).toBe("0");
    expect(column.getAttribute("role")).toBe("region");
    expect(column.getAttribute("aria-live")).toBeNull();
  });

  it("is nothing to focus while it has no sentence yet", () => {
    const { container } = render(<ReasoningColumn text="Looking at the" live />);
    const column = container.querySelector<HTMLElement>("[data-slot=reasoning-column]")!;
    expect(column.children).toHaveLength(0);
    expect(column.getAttribute("tabindex")).toBeNull();
  });

  it("jumps to its newest line when it mounts tall", () => {
    const scrollTo = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollTo: typeof scrollTo };
    const was = proto.scrollTo;
    proto.scrollTo = scrollTo;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 192 });
    try {
      render(<ReasoningColumn text="One. Two. Three." live />);
      expect(scrollTo).toHaveBeenCalledWith({ top: 208, behavior: "auto" });
    } finally {
      proto.scrollTo = was;
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 0 });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 0 });
    }
  });

  it("follows its newest line, unless the person scrolled up, until they reach the bottom again", () => {
    const view = render(<ReasoningColumn text="One." live />);
    const column = view.container.querySelector<HTMLElement>("[data-slot=reasoning-column]")!;
    // A column taller than its cap: 100px a sentence in a 192px box.
    Object.defineProperty(column, "scrollHeight", { configurable: true, get: () => column.querySelectorAll("span").length * 100 });
    Object.defineProperty(column, "clientHeight", { configurable: true, get: () => 192 });
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      column.scrollTop = opts.top ?? 0;
    });
    column.scrollTo = scrollTo as unknown as typeof column.scrollTo;
    view.rerender(<ReasoningColumn text="One. Two." live />);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 8, behavior: "smooth" });
    // The person wheels up: the next sentence leaves them where they read.
    fireEvent.wheel(column, { deltaY: -40 });
    column.scrollTop = 4;
    fireEvent.scroll(column);
    view.rerender(<ReasoningColumn text="One. Two. Three." live />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // Back at the bottom, the column follows again.
    column.scrollTop = 108;
    fireEvent.scroll(column);
    view.rerender(<ReasoningColumn text="One. Two. Three. Four." live />);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe("ThoughtSeconds", () => {
  it("counts the block's seconds on the shared second hand, tabular and muted, and only while live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const view = render(<ThoughtSeconds startedAt={6_000} live />);
    const figure = () => view.container.querySelector("[data-slot=thought-seconds]");
    expect(figure()?.textContent).toBe("4s");
    expect(figure()?.className).toContain("tabular-nums");
    expect(figure()?.className).toContain("text-muted-foreground");
    expect(clockForTest.listeners()).toBe(1);
    vi.setSystemTime(78_000);
    act(() => clockForTest.tick());
    expect(figure()?.textContent).toBe("1m 12s");
    view.rerender(<ThoughtSeconds startedAt={6_000} live={false} />);
    expect(clockForTest.listeners()).toBe(0);
    expect(figure()).toBeNull();
  });

  it("draws nothing without a start to count from", () => {
    const { container } = render(<ThoughtSeconds startedAt={undefined} live />);
    expect(container.innerHTML).toBe("");
  });
});
