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
import { type Task, TaskList, TaskRows } from "./task-list";
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
  fireEvent.mouseMove(el);
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

  it("reads the active label in full foreground, with no pulse anywhere in the list", () => {
    const { container } = render(<TaskList tasks={TASKS} />);
    expect(labelOf(container, LONG).className).toContain("text-foreground");
    expect(container.querySelector('[data-slot="working-text"]')).toBeNull();
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
    expect(container.querySelector("li .tabular-nums")?.className).toContain("text-(--task-done)");
    expect(timeOf(container, 1)).toBeNull();
    expect(timeOf(container, 2)).toBeNull();
  });

  it("ticks on the shared clock while its task runs", () => {
    const from = 1_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(from + 10_000);
    const { container } = render(<TaskList tasks={[{ id: "1", label: LONG, state: "active", time: { ms: 5_000, from } }]} />);
    expect(timeOf(container, 0)).toBe("15s");
    expect(container.querySelector("li .tabular-nums")?.className).toContain("text-muted-foreground");
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

describe("a task's detail", () => {
  const steps = <p>Edited SplitShell.tsx</p>;
  const withDetail = (detail: Partial<Task>): Task[] => TASKS.map((t) => (t.state === "active" ? { ...t, ...detail } : t));

  it("opens under its own row, indented to the label, inside a disclosure", () => {
    const { container } = render(<TaskList tasks={withDetail({ detail: steps })} />);
    const panel = container.querySelector<HTMLElement>("[data-task-detail]")!;
    expect(panel.textContent).toBe("Edited SplitShell.tsx");
    expect(panel.className).toContain("collapsible-auto");
    expect(panel.closest("li")?.textContent).toContain(LONG);
    expect(panel.firstElementChild?.className).toContain("ps-6");
    expect(container.querySelectorAll("[data-task-detail]")).toHaveLength(1);
  });

  it("makes only the row with a detail a trigger", () => {
    const { container } = render(<TaskList tasks={withDetail({ detail: steps })} />);
    const triggers = [...container.querySelectorAll("li [data-slot='collapsible-trigger']")];
    expect(triggers).toHaveLength(1);
    expect(triggers[0].textContent).toContain(LONG);
    cleanup();
    const plain = render(<TaskList tasks={TASKS} />);
    expect(plain.container.querySelectorAll("li [data-slot='collapsible-trigger']")).toHaveLength(0);
  });

  it("stays shut when the person closed it, and says so through its callback", () => {
    const onDetailOpenChange = vi.fn();
    const { container, rerender } = render(<TaskList tasks={withDetail({ detail: steps, onDetailOpenChange })} />);
    fireEvent.click(container.querySelector("li [data-slot='collapsible-trigger']")!);
    expect(onDetailOpenChange).toHaveBeenCalledWith(false);
    rerender(<TaskList tasks={withDetail({ detail: steps, detailOpen: false, onDetailOpenChange })} />);
    expect(container.querySelector("[data-task-detail]")?.hasAttribute("data-open") ?? false).toBe(false);
  });

  it("folds when the detail goes, holding its last content while it shuts", () => {
    const { container, rerender } = render(<TaskList tasks={withDetail({ detail: steps })} />);
    rerender(<TaskList tasks={TASKS.map((t) => (t.state === "active" ? { ...t, state: "done" as const } : t))} />);
    const panel = container.querySelector("[data-task-detail]");
    // Either still shutting with the held steps, or gone: never open.
    expect(panel === null || !panel.hasAttribute("data-open")).toBe(true);
    if (panel) expect(panel.textContent).toBe("Edited SplitShell.tsx");
    expect(container.querySelectorAll("li [data-slot='collapsible-trigger']")).toHaveLength(0);
  });
});

describe("its fitted width", () => {
  const measure = (text: string) => text.length * 6;

  it("reports the card's width from the injected measurer, and again only when the labels change", () => {
    const onFitWidth = vi.fn();
    const tasks: Task[] = [
      { id: "1", label: "Docs", state: "done", time: { ms: 3000 } },
      { id: "2", label: "Measure the labels", state: "active", time: { ms: 1000, from: 0 } },
    ];
    const { rerender } = render(<TaskList tasks={tasks} onFitWidth={onFitWidth} measureText={measure} />);
    expect(onFitWidth).toHaveBeenCalledTimes(1);
    // The widest row (border, inset, mark, gap, label, gap, the widest time) beats the header.
    expect(onFitWidth).toHaveBeenLastCalledWith(2 * 13 + 22 + 18 * 6 + 8 + 7 * 6);
    rerender(<TaskList tasks={tasks.map((t) => ({ ...t, state: "done" as const }))} onFitWidth={onFitWidth} measureText={measure} />);
    expect(onFitWidth).toHaveBeenCalledTimes(1);
    rerender(<TaskList tasks={[...tasks, { id: "3", label: "A much longer task label than before", state: "pending" }]} onFitWidth={onFitWidth} measureText={measure} />);
    expect(onFitWidth).toHaveBeenCalledTimes(2);
  });

  it("reports nothing without a canvas or a measurer", () => {
    const onFitWidth = vi.fn();
    render(<TaskList tasks={TASKS} onFitWidth={onFitWidth} />);
    expect(onFitWidth).not.toHaveBeenCalled();
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
    expect(headline.querySelector('[data-slot="working-text"]')).toBeNull();
  });
});

describe("the compact rows", () => {
  const timed: Task[] = [
    { id: "1", label: "Read the brief", state: "done", time: { ms: 12_000 } },
    { id: "2", label: LONG, state: "active", time: { ms: 5_000 }, progress: 0.4, detail: <span data-steps>steps</span> },
    { id: "3", label: "Tests", state: "pending" },
  ];

  it("draws done, active and pending marks with their states on 20px rows", () => {
    const { container } = render(<TaskRows size="compact" tasks={timed} />);
    expect(container.querySelector("ul")?.dataset.size).toBe("compact");
    const rows = [...container.querySelectorAll("li")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector(".task-mark")?.getAttribute("data-state"))).toEqual(["done", "active", "pending"]);
    for (const row of rows) {
      expect(row.className).toContain("min-h-5");
      expect(row.className).toContain("gap-2");
      expect(row.className).not.toContain("min-h-7");
      const mark = row.querySelector(".task-mark")!;
      expect(mark.getAttribute("class")).toContain("size-3");
      expect(mark.getAttribute("class")).not.toContain("size-3.5");
    }
  });

  it("cuts every label to one 12px line, the active one too", () => {
    const { container } = render(<TaskRows size="compact" tasks={timed} />);
    for (const label of container.querySelectorAll<HTMLElement>(".task-label")) {
      expect(label.className).toContain("truncate");
      expect(label.className).toContain("text-xs");
      expect(label.className).toContain("leading-5");
      expect(label.className).not.toContain("break-words");
    }
    expect(labelOf(container, LONG).className).toContain("text-foreground");
    expect(labelOf(container, "Read the brief").className).toContain("text-(--task-done)");
    expect(labelOf(container, "Tests").className).toContain("text-muted-foreground");
  });

  it("shows no time, detail, trigger or share", () => {
    const { container } = render(<TaskRows size="compact" tasks={timed} />);
    expect(container.querySelector(".tabular-nums")).toBeNull();
    expect(container.querySelector("[data-steps]")).toBeNull();
    expect(container.querySelector("[data-slot='collapsible-trigger']")).toBeNull();
    expect(container.querySelector(".task-share")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("puts the 12px cursor on the active row, still on its first spot", () => {
    const { container } = render(<TaskRows size="compact" tasks={timed} />);
    const cursor = container.querySelector(".task-cursor")!;
    expect(cursor).not.toBeNull();
    expect(cursor.getAttribute("class")).toContain("size-3");
    expect(cursor.getAttribute("class")).not.toContain("size-3.5");
    expect(cursor.hasAttribute("data-slide")).toBe(false);
  });

  it("draws no cursor when nothing is active", () => {
    const { container } = render(<TaskRows size="compact" tasks={timed.map((task) => ({ ...task, state: "done" as const }))} />);
    expect(container.querySelector(".task-cursor")).toBeNull();
  });

  it("leaves the card's rows as they were: 28px, times, the share chip", () => {
    const { container } = render(<TaskRows tasks={timed} />);
    expect(container.querySelector("ul")?.className).toContain("px-3");
    expect(container.querySelector("li")?.className).toContain("min-h-7");
    expect(container.querySelector("li .tabular-nums")?.textContent).toBe("12s");
    expect(container.querySelector(".task-share")?.textContent).toBe("40%");
  });
});

describe("press and hover", () => {
  const press = ["hover:bg-foreground/5", "duration-(--dur-hover)", "active:bg-foreground/12", "active:transition-none", "motion-reduce:transition-none"];

  it("the header and a row with steps hover at /5 over --dur-hover and press to /12 at once", () => {
    const tasks = TASKS.map((t) => (t.state === "active" ? { ...t, detail: <p>Edited a.ts</p> } : t));
    const { container } = render(<TaskList tasks={tasks} />);
    const header = container.querySelector<HTMLElement>("[data-slot='task-list'] > [data-slot='collapsible-trigger']")!;
    const row = container.querySelector<HTMLElement>("li [data-slot='collapsible-trigger']")!;
    for (const c of press) {
      expect(header.className).toContain(c);
      expect(row.className).toContain(c);
    }
    expect(row.className).not.toContain("duration-(--dur-fast)");
  });

  it("the header's chevron is the one disclosure: a ChevronRight turning 90° with the list", () => {
    const { container } = render(<TaskList tasks={TASKS} />);
    const header = container.querySelector<HTMLElement>("[data-slot='task-list'] > [data-slot='collapsible-trigger']")!;
    const chevron = () => header.querySelector("[data-slot='task-chevron']")!.getAttribute("class")!;
    expect(chevron()).toContain("rotate-90");
    expect(chevron()).toContain("duration-(--dur-base)");
    expect(header.className).toContain("data-panel-open:rounded-b-none");
    fireEvent.click(header);
    expect(chevron()).not.toContain("rotate-90");
  });
});
