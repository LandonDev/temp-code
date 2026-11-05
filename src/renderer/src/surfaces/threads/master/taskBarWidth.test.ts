/** One task bar width per master board (docs/LAYOUT.md "Master"): the
 *  folded list's widest row over every implementation and orchestration
 *  row's tasks, floored. */
import { describe, expect, it } from "vitest";
import { boardTaskLabels, COMPACT_GAP_PX, COMPACT_MARK_PX, fitTaskBar, TASK_BAR_MIN_PX, taskBarStyle } from "./taskBarWidth";

const byLength = (text: string) => text.length * 6;
const todo = (content: string, status: "pending" | "in_progress" | "completed" = "pending") => ({ content, status });

describe("fitTaskBar", () => {
  it("is the compact row's mark, its gap and the widest label, rounded up", () => {
    const long = "Write the project header rows with their glyphs";
    expect(fitTaskBar(["Read", long, "Docs"], byLength)).toBe(COMPACT_MARK_PX + COMPACT_GAP_PX + long.length * 6);
    expect(fitTaskBar(["x".repeat(40)], (t) => t.length * 6.05)).toBe(Math.ceil(18 + 242));
  });

  it("never goes under its floor, with short labels or none", () => {
    expect(TASK_BAR_MIN_PX).toBe(160);
    expect(fitTaskBar(["Read", "Docs"], byLength)).toBe(160);
    expect(fitTaskBar([], byLength)).toBe(160);
  });
});

describe("boardTaskLabels", () => {
  const digests: Record<string, { todos?: ReturnType<typeof todo>[] }> = {
    a: { todos: [todo("Tests"), todo("Read the brief", "completed")] },
    b: { todos: [todo("Docs"), todo("Tests")] },
    plan: { todos: [todo("A planner's very long task that no bar shows")] },
    none: {},
  };
  const rows = [
    { id: "a", threadType: "implementation" },
    { id: "b", threadType: "orchestration" },
    { id: "plan", threadType: "planning" },
    { id: "none", threadType: "implementation" },
  ];
  const of = (id: string) => digests[id] ?? {};

  it("takes every implementation and orchestration row's labels once, sorted", () => {
    expect(boardTaskLabels(rows, of)).toBe(["Docs", "Read the brief", "Tests"].join("\n"));
  });

  it("is the same key after a tick or a reorder, and a new one when a label changes", () => {
    const before = boardTaskLabels(rows, of);
    const ticked = { ...digests, a: { todos: [todo("Read the brief", "completed"), todo("Tests", "in_progress")] } };
    expect(boardTaskLabels([...rows].reverse(), (id) => ticked[id] ?? {})).toBe(before);
    const renamed = { ...digests, b: { todos: [todo("Docs and CLAUDE.md"), todo("Tests")] } };
    expect(boardTaskLabels(rows, (id) => renamed[id] ?? {})).not.toBe(before);
  });
});

describe("taskBarStyle", () => {
  it("hands the width to the rows as one variable, and nothing before a measure", () => {
    expect(taskBarStyle(306)).toEqual({ "--task-bar": "306px" });
    expect(taskBarStyle(null)).toBeUndefined();
  });
});
