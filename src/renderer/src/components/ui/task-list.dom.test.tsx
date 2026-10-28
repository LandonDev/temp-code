// @vitest-environment jsdom
/** The dense list's rows on the 4px grid: a task row and a changed file are 28px, as every dense row is. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeRows } from "../../surfaces/threads/ChangeRows";
import type { ChangeGroup } from "../../surfaces/threads/implementationBoard";
import { TaskList } from "./task-list";

afterEach(cleanup);

describe("dense rows at 28px", () => {
  it("every task row is at least 28px with its text centred on a 20px line, a wrapping task growing by whole lines", () => {
    const { container } = render(
      <TaskList
        tasks={[
          { id: "1", label: "Read the brief", state: "done" },
          { id: "2", label: "Write the view", state: "active" },
          { id: "3", label: "Tests", state: "pending" },
          { id: "4", label: "Docs", state: "pending" },
        ]}
      />,
    );
    const rows = [...container.querySelectorAll("[data-slot='task-list'] li")];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.className).toContain("min-h-7");
      expect(row.className).toContain("py-1");
      expect(row.className).not.toContain("py-[3px]");
      expect(row.querySelector(".task-label")?.className).toContain("leading-5");
    }
  });

  it("a changed file's row is one 28px line", () => {
    const groups = [{ key: "g", task: null, files: [{ path: "/repo/src/a.ts", name: "a.ts", adds: 3, dels: 1, edits: [], editing: false }] }] as unknown as ChangeGroup[];
    const { container } = render(<ChangeRows groups={groups} cwd="/repo" onOpenFile={() => {}} onOpenDiff={() => {}} />);
    const row = container.querySelector("[data-change-row] [data-slot='item']") ?? container.querySelector("[data-change-row] > *")!;
    expect(row.className).toContain("h-7");
    expect(row.className).toContain("py-0");
    expect(row.className).not.toContain("py-1.5");
  });
});
