// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Collapsible } from "../components/ui/collapsible";
import { StatusMark } from "../components/ui/status";
import { setEditorConfigForTest } from "./editorConfig";
import { ActionGroup } from "../surfaces/transcript/ActionGroup";
import { fixtures } from "../surfaces/transcript/ActionGroup.fixtures";
import { NoticeLine } from "../surfaces/transcript/NoticeLine";
import { CompactionCard } from "../surfaces/CompactionCard";
import { TurnDuration, WatchingLine } from "../surfaces/transcript/TurnEnd";

// The one spacing rule of a line (docs/DESIGN.md "Typography and text
// hierarchy"): a glyph sits 8px from the first word; each word, detail, count
// or time 4px from the next; a chevron or the hover actions 8px after the last
// value. jsdom lays nothing out, so the space between two elements is read from
// their classes: the gap of the flex row they share, plus the trailing margin
// of the first's branch and the leading margin of the second's.
// scripts/measure-line-pairs.ts reads the same pairs in a browser.

beforeAll(() => setEditorConfigForTest(null));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const GAP: Record<string, number> = { "gap-0": 0, "gap-0.5": 2, "gap-1": 4, "gap-1.5": 6, "gap-2": 8, "gap-x-1": 4, "gap-x-2": 8 };
const START: Record<string, number> = { "ms-0.5": 2, "ms-1": 4, "ms-2": 8, "-ms-0.5": -2, "-ms-1": -4 };
const END: Record<string, number> = { "me-0.5": 2, "me-1": 4, "me-2": 8 };

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const sum = (el: Element, table: Record<string, number>) => classes(el).reduce((n, c) => n + (table[c] ?? 0), 0);

/** The space between two elements of one line, from the classes that make it. */
function space(a: Element, b: Element): number {
  let row: Element | null = a.parentElement;
  while (row && !row.contains(b)) row = row.parentElement;
  if (!row) throw new Error("the two share no row");
  const branch = (el: Element) => {
    let at = el;
    while (at.parentElement !== row) at = at.parentElement!;
    return at;
  };
  return sum(row, GAP) + sum(branch(a), END) + sum(branch(b), START);
}

const text = (words: string) => screen.getByText(words, { exact: true });

describe("a line's words sit 4px apart, its glyph and chevron 8px", () => {
  it("StatusMark: the glyph 8px from the word, the detail 4px after it", () => {
    const { container } = render(<StatusMark state="working" detail="Editing Rail.tsx" />);
    const glyph = container.querySelector("[data-slot=status-glyph]")!;
    expect(space(glyph, text("Working"))).toBe(8);
    expect(space(text("Working"), text("Editing Rail.tsx"))).toBe(4);
  });

  it("the Watching line: its subject 4px after the word, the age 4px after the subject", () => {
    // A whole second, so the clock's first tick lands a second in.
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    render(<WatchingLine since={Date.now() - 5 * 60_000} subject="3 subagents" onOpen={() => {}} />);
    act(() => vi.advanceTimersByTime(1_000));
    const age = text("5m 1s");
    expect(space(text("Watching"), text("3 subagents"))).toBe(4);
    expect(space(text("3 subagents"), age)).toBe(4);
  });

  it("the live closing line: the time 4px after the word", () => {
    render(<TurnDuration elapsedMs={65_000} live />);
    expect(space(text("Working"), text("1m 5s"))).toBe(4);
  });

  it("a notice: lead and its details' run 4px apart, the glyph 8px before, the chevron 8px after", () => {
    const { container } = render(
      <Collapsible>
        <NoticeLine glyph={<svg data-testid="glyph" />} lead="Context compacted" details={["414K → 3.6K", "1m 29s"]} fold={{ open: false, label: "Compaction" }} />
      </Collapsible>,
    );
    const glyph = screen.getByTestId("glyph").parentElement!;
    const chevron = container.querySelector("[data-slot=notice-line] svg:not([data-testid])")!;
    expect(space(glyph, text("Context compacted"))).toBe(8);
    expect(space(text("Context compacted"), text("414K → 3.6K, 1m 29s"))).toBe(4);
    expect(space(text("414K → 3.6K, 1m 29s"), chevron)).toBe(8);
  });

  it("the compaction line: a medium lead, its details one comma run 4px after it, the glyph 8px before", () => {
    const { container } = render(
      <CompactionCard block={{ id: "c", role: "system", text: "", compaction: { phase: "done", preTokens: 414_000, postTokens: 3_600, durationMs: 89_000 } }} />,
    );
    const glyph = container.querySelector("[data-slot=notice-line] > div > span")!;
    const lead = text("Context compacted");
    const run = text("414K → 3.6K, 1m 29s");
    expect(lead.className).toContain("font-medium");
    expect(container.querySelectorAll("[data-slot=notice-details]")).toHaveLength(1);
    expect(space(lead, run)).toBe(4);
    expect(space(glyph, lead)).toBe(8);
  });

  it("a step: glyph 8px to the verb, verb 4px to the target, the counts 4px after, the caret 8px after them", () => {
    const fixture = fixtures.find((f) => f.name === "Mixed calls, opened")!;
    const { container } = render(<ActionGroup {...fixture.props} />);
    const row = container.querySelector<HTMLElement>('[data-step="mixed3"] .group\\/action')!;
    const glyph = row.querySelector("[data-glyph]")!;
    const verb = [...row.querySelectorAll("span")].find((el) => el.textContent === "Created" && el.children.length === 0)!;
    const target = [...row.querySelectorAll("span")].find((el) => el.textContent === "diag.ts" && el.children.length === 0)!;
    const counts = row.querySelector("[data-slot=counts]") ?? [...row.querySelectorAll("span")].find((el) => el.textContent === "+46")!;
    const caret = row.querySelector(":scope > svg")!;
    expect(space(glyph, verb)).toBe(8);
    expect(space(verb, target)).toBe(4);
    expect(space(target, counts)).toBe(4);
    expect(space(counts, caret)).toBe(8);
  });

  it("the group line: glyph 8px to the phrase, the counts 4px after it, the chevron 8px after them", () => {
    const fixture = fixtures.find((f) => f.name === "Mixed calls, opened")!;
    const { container } = render(<ActionGroup {...fixture.props} />);
    const line = container.querySelector("[data-group-line]")!;
    const glyph = line.querySelector("[data-kind]")!;
    const phrase = line.querySelector("[data-slot=morph-text]")!;
    const counts = phrase.nextElementSibling!;
    const chevron = line.querySelector(":scope > svg")!;
    expect(space(glyph, phrase)).toBe(8);
    expect(space(phrase, counts)).toBe(4);
    expect(space(counts, chevron)).toBe(8);
  });
});
