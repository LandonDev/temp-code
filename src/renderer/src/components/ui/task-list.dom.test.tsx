// @vitest-environment jsdom
/** The dense list's rows on the 4px grid: a task row and a changed file are
 *  28px, as every dense row is. A task is one cut line with its whole text on
 *  hover, the active one whole and bright, each started task's time at the end. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "../../hooks/paneVisibility";
import { clockForTest } from "../../lib/turnClock";
import { ChangeRows } from "../../surfaces/threads/ChangeRows";
import type { ChangeGroup } from "../../surfaces/threads/implementationBoard";
import { type Task, TaskList } from "./task-list";
import { tooltipChunk, warmTooltips } from "./tooltip";

const LONG = "Make every task one line that fits the column, with the whole text on hover";

const TASKS: Task[] = [
  { id: "1", label: "Read the brief", state: "done" },
  { id: "2", label: LONG, state: "active" },
  { id: "3", label: "Tests", state: "pending" },
  { id: "4", label: "Docs", state: "pending" },
];

const labelOf = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLElement>(".task-label")].find((el) => el.textContent === text)!;

const hover = (el: HTMLElement) => {
  fireEvent.pointerEnter(el);
  fireEvent.mouseEnter(el);
  fireEvent.focus(el);
};
const tipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dense rows at 28px", () => {
  it("every task row is at least 28px with its text on a 20px line", () => {
    const { container } = render(<TaskList tasks={TASKS} />);
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

describe("each task fits its column", () => {
  it("cuts a done and a pending label to one line and leaves the active one whole", () => {
    const { container } = render(<TaskList tasks={TASKS} />);
    for (const text of ["Read the brief", "Tests"]) {
      const label = labelOf(container, text);
      expect(label.className).toContain("truncate");
      expect(label.className).toContain("min-w-0");
      expect(label.className).not.toContain("w-fit");
    }
    const active = labelOf(container, LONG);
    expect(active.className).not.toContain("truncate");
    expect(active.className).toContain("break-words");
  });

  it("reads the active label in full foreground, with no shimmer anywhere in the list", () => {
    const { container } = render(<TaskList tasks={TASKS} />);
    expect(labelOf(container, LONG).className).toContain("text-foreground");
    expect(container.querySelector(".shimmer")).toBeNull();
  });

  it("shows a cut label's whole text on hover, and nothing for a label that fits", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const cut = render(<TaskList tasks={[{ id: "1", label: LONG, state: "pending" }]} />);
    hover(screen.getByText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG), { timeout: 2000 });
    cut.unmount();
    vi.restoreAllMocks();
    render(<TaskList tasks={[{ id: "1", label: "Docs", state: "pending" }]} />);
    hover(screen.getByText("Docs"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(tipText()).toBeNull();
  });
});

describe("a task's time", () => {
  const timeOf = (container: HTMLElement, row: number) =>
    container.querySelectorAll("li")[row].querySelector(".tabular-nums")?.textContent ?? null;

  it("ends a started task's row, and nothing under 1.5 s or on a pending task", () => {
    const { container } = render(
      <TaskList
        tasks={[
          { id: "1", label: "Read the brief", state: "done", time: { ms: 12_000 } },
          { id: "2", label: "Gate", state: "done", time: { ms: 1_200 } },
          { id: "3", label: "Docs", state: "pending" },
        ]}
      />,
    );
    expect(timeOf(container, 0)).toBe("12s");
    expect(timeOf(container, 1)).toBeNull();
    expect(timeOf(container, 2)).toBeNull();
  });

  it("ticks on the shared clock while its task runs", () => {
    const from = 1_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(from + 10_000);
    const { container } = render(<TaskList tasks={[{ id: "1", label: LONG, state: "active", time: { ms: 5_000, from } }]} />);
    expect(timeOf(container, 0)).toBe("15s");
    now.mockReturnValue(from + 20_000);
    act(() => clockForTest.tick());
    expect(timeOf(container, 0)).toBe("25s");
  });

  it("holds its counted part in a parked pane", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_010_000);
    const { container } = render(
      <PaneVisibilityContext.Provider value={false}>
        <TaskList tasks={[{ id: "1", label: LONG, state: "active", time: { ms: 5_000, from: 1_000_000_000 } }]} />
      </PaneVisibilityContext.Provider>,
    );
    expect(timeOf(container, 0)).toBe("5s");
  });
});

describe("the folded list's header", () => {
  it("names the active task on one cut line inside the card", () => {
    render(<TaskList defaultOpen={false} tasks={TASKS} />);
    const headline = screen.getByText(LONG);
    expect(headline.tagName).toBe("SPAN");
    expect(headline.className).toContain("block");
    expect(headline.className).toContain("truncate");
    expect(headline.className).toContain("min-w-0");
    expect(headline.querySelector(".shimmer")).toBeNull();
  });
});
