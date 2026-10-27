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
  ...over,
});

afterEach(cleanup);

describe("ActivityThinkingRow", () => {
  it("live: Thinking and the newest sentence, nothing to press", () => {
    render(<ActivityThinkingRow block={thought({ streaming: true })} expandable />);
    const row = screen.getByLabelText("Thinking");
    expect(row.textContent).toContain("Thinking");
    expect(row.textContent).toContain("Now I check the tests.");
    expect(row.textContent).not.toContain("I read the file.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("settled: Thought for 4s, closed until clicked", () => {
    const view = render(<ActivityThinkingRow block={thought()} endTs={14_000} expandable />);
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toBe("Thought for 4s");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain("Now I check");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("Now I check the tests.");
  });

  it("reads Thought without an end time, and does not open when not expandable", () => {
    render(<ActivityThinkingRow block={thought()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
  });
});
