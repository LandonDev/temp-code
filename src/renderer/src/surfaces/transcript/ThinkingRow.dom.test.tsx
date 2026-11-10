// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import { ActivityThinkingRow } from "./ThinkingRow";

const thought = (over: Partial<Block> = {}): Block => ({
  id: "r1",
  role: "reasoning",
  text: "I read the file. Now I check the tests.",
  startedAt: 10_000,
  doneTs: 14_000,
  ...over,
});

afterEach(cleanup);

describe("ActivityThinkingRow", () => {
  it("is the whole thought, readable at once: no Thought word, no button, no chevron, no duration", () => {
    const view = render(<ActivityThinkingRow block={thought()} />);
    expect(view.container.textContent).toBe("I read the file. Now I check the tests.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(view.container.querySelector("svg.rotate-90, [aria-expanded]")).toBeNull();
    expect(view.container.textContent).not.toMatch(/for \d|\d+s/);
    expect(view.container.querySelector("[data-slot=working-text]")).toBeNull();
  });

  it("sits on the step grid: the thought glyph in the 14px slot, the text in the reasoning column's type on the text column", () => {
    const view = render(<ActivityThinkingRow block={thought({ text: "First.\n\nSecond paragraph." })} />);
    const row = view.container.querySelector<HTMLElement>("[data-slot=thought-row]")!;
    expect(row.className).toContain("items-start");
    expect(row.className).toContain("in-data-[table]:px-3");
    const glyph = row.firstElementChild as HTMLElement;
    expect(glyph.className).toContain("size-3.5");
    expect(glyph.querySelector("svg")).not.toBeNull();
    // The text column takes the row's width; the markdown inside is AgentMarkdown at
    // the prose size with `.agent-reasoning` (14px on 22px lines, muted; the jsdom
    // render holds the text in its placeholder, so the classes are read in the browser).
    const column = row.querySelector<HTMLElement>("[data-thought-text]")!;
    expect(column.className).toBe("min-w-0 flex-1");
    expect(column.textContent).toContain("First.");
    expect(column.textContent).toContain("Second paragraph.");
  });
});
