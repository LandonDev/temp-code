// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";
import { ActivityThinkingRow, ThinkingTail } from "./ThinkingRow";

const thought = (over: Partial<Block> = {}): Block => ({
  id: "r1",
  role: "reasoning",
  text: "I read the file. Now I check the tests.",
  ts: 10_000,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const swaps = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-swap-text]")].map((el) => [el.getAttribute("data-swap-text"), el.textContent]);

describe("ActivityThinkingRow", () => {
  it("live: Thinking pulsing and the newest sentence, nothing to press", () => {
    const view = render(<ActivityThinkingRow block={thought({ streaming: true })} expandable />);
    const row = screen.getByLabelText("Thinking");
    expect(row.textContent).toContain("Thinking");
    expect(row.textContent).toContain("Now I check the tests.");
    expect(row.textContent).not.toContain("I read the file.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(view.container.querySelector("[data-slot=text-pulse]")?.textContent).toBe("Thinking");
  });

  it("live: the sentence fades in by steps, a growing sentence keeps its first step, a new one remounts", () => {
    const view = render(<ActivityThinkingRow block={thought({ text: "Looking at the", streaming: true })} />);
    const steps = () => Array.from(view.container.querySelectorAll(".stream-step"));
    expect(steps().map((step) => step.textContent)).toEqual(["Looking at the"]);
    expect(steps()[0]?.parentElement?.className).toContain("truncate");
    const first = steps()[0];

    view.rerender(<ActivityThinkingRow block={thought({ text: "Looking at the file.", streaming: true })} />);
    expect(steps().map((step) => step.textContent)).toEqual(["Looking at the", " file."]);
    expect(steps()[0]).toBe(first);

    view.rerender(<ActivityThinkingRow block={thought({ text: "Looking at the file. Then the tests.", streaming: true })} />);
    expect(steps().map((step) => step.textContent)).toEqual(["Then the tests."]);
    expect(steps()[0]).not.toBe(first);
  });

  it("settles in place: the same row, Thinking swapping to Thought for 4s with its chevron, the sentence fading out", async () => {
    const view = render(<ActivityThinkingRow block={thought({ streaming: true })} endTs={14_000} expandable />);
    const row = view.container.querySelector("[data-slot=thought-row]");
    const line = view.container.querySelector("[data-slot=thought-line]");
    expect(swaps(view.container)).toEqual([["live", "Thinking"]]);
    expect(row?.querySelector("svg.size-3")).toBeNull();

    view.rerender(<ActivityThinkingRow block={thought()} endTs={14_000} expandable />);
    expect(view.container.querySelector("[data-slot=thought-row]")).toBe(row);
    expect(swaps(view.container)).toEqual([
      ["live", "Thinking"],
      ["settled", "Thought for 4s"],
    ]);
    const entering = view.container.querySelector("[data-swap-text=settled]") as HTMLElement;
    expect(entering.style.transform).toContain("translateY(3px)");
    // The chevron arrives with the settled words.
    expect(entering.querySelector("svg.size-3")).not.toBeNull();
    // The sentence is leaving: still there, now on its way out.
    expect(view.container.querySelector("[data-slot=thought-line]")).toBe(line);

  });

  it("once settled, the live words and the sentence are gone", async () => {
    // jsdom paints no frames: let Motion finish the exits at once.
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<ActivityThinkingRow block={thought({ streaming: true })} endTs={14_000} expandable />);
    view.rerender(<ActivityThinkingRow block={thought()} endTs={14_000} expandable />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    MotionGlobalConfig.skipAnimations = false;
    expect(view.container.querySelector("[data-slot=thought-line]")).toBeNull();
    expect(swaps(view.container)).toEqual([["settled", "Thought for 4s"]]);
    expect(view.container.querySelector("[data-slot=text-pulse]")).toBeNull();
  });

  it("a thought watched live that ends its group times itself by its settle", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(10_000);
      const view = render(<ActivityThinkingRow block={thought({ ts: 10_000, streaming: true })} expandable />);
      vi.setSystemTime(13_000);
      view.rerender(<ActivityThinkingRow block={thought({ ts: 10_000 })} expandable />);
      expect(screen.getByRole("button", { name: "Thought for 3s" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settled: Thought for 4s, closed until clicked", () => {
    const view = render(<ActivityThinkingRow block={thought()} endTs={14_000} expandable />);
    const trigger = screen.getByRole("button", { name: "Thought for 4s" });
    expect(trigger.className).toContain("focus-visible:ring-ring");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain("Now I check");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("Now I check the tests.");
    // The button lies over the row it names: a 28px line at 13px.
    const row = view.container.querySelector("[data-slot=thought-row]")!;
    expect(trigger.parentElement).toBe(row);
    expect(trigger.className).toContain("absolute inset-0");
    const drawn = row.firstElementChild as HTMLElement;
    expect(drawn.getAttribute("aria-hidden")).toBe("true");
    expect(drawn.className).toContain("min-h-7");
    expect(drawn.className).toContain("text-[13px]");
  });

  it("reads Thought without an end time, and does not open when not expandable", () => {
    render(<ActivityThinkingRow block={thought()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
  });
});

describe("ThinkingTail", () => {
  it("pulses its word and swaps a new phase through SwapText once the hold ends", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = render(<ThinkingTail word="Sending" />);
    const pulse = view.container.querySelector("[data-slot=text-pulse]");
    expect(pulse?.className).toContain("text-pulse");
    expect(swaps(view.container)).toEqual([["Sending", "Sending"]]);

    view.rerender(<ThinkingTail word="Starting the CLI" />);
    // The painted word holds 300 ms.
    expect(swaps(view.container)).toEqual([["Sending", "Sending"]]);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(swaps(view.container)).toEqual([
      ["Sending", "Sending"],
      ["Starting the CLI", "Starting the CLI"],
    ]);
    // Inside the same pulse: the swap never restarts the breath.
    expect(view.container.querySelector("[data-slot=text-pulse]")).toBe(pulse);
    const entering = view.container.querySelector('[data-swap-text="Starting the CLI"]') as HTMLElement;
    expect(entering.style.transform).toContain("translateY(3px)");
    expect(screen.getByLabelText("Starting the CLI")).toBeTruthy();
  });
});
