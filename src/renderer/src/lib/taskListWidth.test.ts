// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_BORDER_PX, TASK_CHEVRON_PX, TASK_GAP_PX, TASK_INSET_PX, TASK_MARK_PX, TASK_TALLY_GAP_PX, TaskList } from "../components/ui/task-list";
import { canvasMeasure, FIT_MIN_PX, fitCard, fitColumn, type Measure } from "./taskListWidth";

/** 6px a character for a label, 5px for a time: easy sums. */
const measure: Measure = (text, font) => text.length * (font === "label" ? 6 : 5);
/** The fixed part of a row: border and inset each side, the mark and its gap. */
const FRAME = 2 * (1 + 12) + 14 + 8;

afterEach(cleanup);

describe("fitCard", () => {
  it("takes the widest label", () => {
    expect(fitCard({ labels: ["Docs", "Measure the labels", "Tests"], hasTimes: false }, measure)).toBe(FRAME + 18 * 6);
  });

  it("keeps a slot for the widest time only when a task has a time", () => {
    const labels = ["Measure the labels"];
    // "59m 59s" is seven characters, after its 8px gap.
    expect(fitCard({ labels, hasTimes: true }, measure)).toBe(FRAME + 18 * 6 + 8 + 7 * 5);
    expect(fitCard({ labels, hasTimes: false }, measure)).toBe(FRAME + 18 * 6);
  });

  it("is never narrower than its header", () => {
    const header = { title: "Tasks", tally: "12/12" };
    // donut and gap, the title, a gap, the tally, 8px, the chevron.
    const head = 14 + 8 + 5 * 6 + 8 + 5 * 6 + 8 + 14;
    expect(fitCard({ labels: ["A"], hasTimes: false, header }, measure)).toBe(2 * (1 + 12) + head);
  });

  it("rounds up to a whole pixel", () => {
    expect(fitCard({ labels: ["x"], hasTimes: false }, () => 10.2)).toBe(FRAME + 11);
  });
});

describe("fitColumn", () => {
  it("adds the board's inset and never goes under the floor", () => {
    expect(fitColumn(400, 24)).toBe(448);
    expect(fitColumn(100, 24)).toBe(FIT_MIN_PX);
    expect(FIT_MIN_PX).toBe(320);
  });

  it("stops at the board content's widest", () => {
    expect(fitColumn(900, 24, 672)).toBe(672);
    expect(fitColumn(400, 24, 672)).toBe(448);
  });
});

describe("the constants are the list's classes", () => {
  it("each px matches the Tailwind class it stands for", () => {
    const { container } = render(createElement(TaskList, { tasks: [{ id: "1", label: "Docs", state: "pending" }] }));
    const card = container.querySelector<HTMLElement>("[data-slot='task-list']")!;
    const header = card.querySelector<HTMLElement>("[data-slot='collapsible-trigger']")!;
    const row = card.querySelector("li > div")!;
    const mark = row.querySelector(".task-mark")!;
    const chevron = header.querySelector("[data-slot=task-chevron]")!;
    const cls = (px: number) => String(px / 4);
    expect(card.className).toContain(TASK_BORDER_PX === 1 ? "border " : "unreachable");
    expect(card.querySelector("ul")!.className).toContain(`px-${cls(TASK_INSET_PX)}`);
    expect(header.className).toContain(`px-${cls(TASK_INSET_PX)}`);
    expect(row.className).toContain(`gap-${cls(TASK_GAP_PX)}`);
    expect(header.className).toContain(`gap-${cls(TASK_GAP_PX)}`);
    // 8px from a mark to its first word, on the 4px grid, at both sizes.
    expect(TASK_GAP_PX).toBe(8);
    expect(mark.getAttribute("class")).toContain(`size-${cls(TASK_MARK_PX)}`);
    expect(chevron.getAttribute("class")).toContain(`size-${cls(TASK_CHEVRON_PX)}`);
    expect(chevron.parentElement!.className).toContain(`gap-${cls(TASK_TALLY_GAP_PX)}`);
    // A chevron sits 8px after the last value, as the board's task bar does.
    expect(TASK_TALLY_GAP_PX).toBe(8);
  });
});

describe("canvasMeasure", () => {
  it("is null where there is no canvas", () => {
    expect(canvasMeasure({ label: "13px sans-serif", time: "12px sans-serif" })).toBeNull();
  });
});
