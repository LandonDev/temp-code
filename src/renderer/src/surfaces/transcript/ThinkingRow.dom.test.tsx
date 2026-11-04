// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import { ActivityThinkingRow } from "./ThinkingRow";

const thought = (over: Partial<Block> = {}): Block => ({
  id: "r1",
  role: "reasoning",
  text: "I read the file. Now I check the tests.",
  ts: 10_000,
  doneTs: 14_000,
  ...over,
});

afterEach(cleanup);

describe("ActivityThinkingRow", () => {
  it("reads Thought with no duration, closed until clicked", () => {
    const view = render(<ActivityThinkingRow block={thought()} expandable />);
    const trigger = screen.getByRole("button", { name: "Thought" });
    expect(view.container.textContent).toBe("Thought");
    expect(view.container.textContent).not.toMatch(/for \d/);
    expect(trigger.className).toContain("focus-visible:ring-ring");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("Now I check the tests.");
  });

  it("lays its button over the 28px row it names", () => {
    const view = render(<ActivityThinkingRow block={thought()} expandable />);
    const row = view.container.querySelector("[data-slot=thought-row]")!;
    const trigger = screen.getByRole("button", { name: "Thought" });
    expect(trigger.parentElement).toBe(row);
    expect(trigger.className).toContain("absolute inset-0");
    const drawn = row.firstElementChild as HTMLElement;
    expect(drawn.getAttribute("aria-hidden")).toBe("true");
    expect(drawn.className).toContain("h-7");
    expect(drawn.className).toContain("text-[13px]");
  });

  it("does not open when not expandable, and never pulses or shows a sentence", () => {
    const view = render(<ActivityThinkingRow block={thought()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(view.container.querySelector("[data-slot=working-text]")).toBeNull();
  });
});
