// @vitest-environment jsdom
/** An implementation or orchestration row on the master board carries its
 *  task bar on a third line and folds open to its task list, open on its
 *  own while the thread is live and folded on its own once it finishes
 *  (docs/LAYOUT.md "Master"); every other row keeps its two lines. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLD_HOLD_MS } from "../../../lib/ease";
import type { BoardDigest } from "@server/shared/contract-batch";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta, ThreadType } from "../../../lib/tcserver/types";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink, wireMeta } from "../../../test/fakeMetaLink";
import { MasterRow, MasterRowView } from "./MasterRow";
import { resetTaskFolds, taskFoldChoice, taskFoldKey, useTaskFold } from "./taskFold";
import { BoardDigestContext, BoardDigests, type BoardRowRef } from "./useMasterModel";

const seven = (done: number, inProgress = true): TodoItem[] =>
  Array.from({ length: 7 }, (_, i) => ({ content: `Task ${String(i + 1)}`, status: i < done ? "completed" : i === done && inProgress ? "in_progress" : "pending" }) as TodoItem);

const meta = (over: Partial<SessionMeta> = {}) => ({ ...wireMeta("c1"), environmentId: "local", status: "running", activity: "Editing", ...over }) as SessionMeta;
const menu = { rowsFor: () => [], onPick: () => {}, onOpenChange: () => {} };
const noGlyph = () => null;

function view(m: SessionMeta, digest: BoardDigest, extra: { tasksChoice?: boolean; onTasksChoice?: (choice: boolean | undefined) => void; onOpen?: (id: string) => void } = {}) {
  return render(<MasterRowView meta={m} digest={digest} agents={null} landed={false} host={null} hostGlyph={noGlyph} onOpen={extra.onOpen ?? (() => {})} menu={menu} tasksChoice={extra.tasksChoice} onTasksChoice={extra.onTasksChoice} />);
}

const row = (container: HTMLElement) => container.querySelector("[data-menu-id]")!;
const trigger = (container: HTMLElement) => container.querySelector<HTMLButtonElement>("[data-task-bar] [data-slot='collapsible-trigger']");
const indicator = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-task-bar] [data-slot='progress-indicator']");

afterEach(() => {
  cleanup();
  resetTaskFolds();
  vi.useRealTimers();
});

describe("the task bar", () => {
  it("fills done of total and says the tally once, on its own line", () => {
    const { container } = view(meta(), { todos: seven(3) });
    expect(indicator(container)?.style.transform).toBe("translateX(-57.14%)");
    expect(container.querySelector("[data-bar-tally]")?.textContent).toBe("3/7");
    expect(container.querySelector("[data-tally]")).toBeNull();
    expect(row(container).textContent?.match(/3\/7/g)).toHaveLength(1);
    // Line two still says the task in hand.
    expect(container.querySelector("[data-row-status]")?.textContent).toBe("Task 4");
  });

  it("names its button by the tasks and says whether it is open", () => {
    const { container } = view(meta(), { todos: seven(3) });
    expect(trigger(container)?.getAttribute("aria-label")).toBe("Tasks: 3 of 7 done");
    expect(trigger(container)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("fills in the foreground while working and muted in every other state", () => {
    const fill = (m: SessionMeta) => {
      const { container, unmount } = view(m, { todos: seven(3) });
      const tone = container.querySelector("[data-task-bar] [data-slot='progress']")?.getAttribute("data-fill");
      unmount();
      return tone;
    };
    expect(fill(meta({ status: "running" }))).toBe("foreground");
    for (const status of ["paused", "watching", "waiting", "error", "queued"] as const) expect(fill(meta({ status, activity: null }))).toBe("muted");
  });

  it("shows on an orchestration row too", () => {
    const { container } = view(meta({ threadType: "orchestration" }), { todos: seven(2) });
    expect(container.querySelector("[data-task-bar]")).not.toBeNull();
  });

  it("is absent with no tasks yet, and on planning, chat and research rows, which keep their end tally", () => {
    const none = view(meta(), {});
    expect(none.container.querySelector("[data-task-bar]")).toBeNull();
    expect(none.container.querySelector("[data-tally]")).toBeNull();
    none.unmount();
    for (const threadType of ["planning", "chat", "research"] as ThreadType[]) {
      const { container, unmount } = view(meta({ threadType }), { todos: seven(3) });
      expect(container.querySelector("[data-task-bar]")).toBeNull();
      expect(container.querySelector("[data-tally]")?.textContent).toBe("3/7");
      unmount();
    }
  });

  it("is absent from a row that is finished when it mounts: no tally when every task is ticked, else it ends line two", () => {
    for (const over of [{ status: "idle" }, { status: "done" }, { status: "stopped" }] as const) {
      const all = view(meta({ ...over, activity: null }), { todos: seven(7, false) });
      expect(all.container.querySelector("[data-task-bar]")).toBeNull();
      expect(all.container.querySelector("[data-task-fold]")).toBeNull();
      expect(all.container.querySelector("[data-tally]")).toBeNull();
      expect(row(all.container).textContent).not.toMatch(/\d\/7/);
      all.unmount();
      const left = view(meta({ ...over, activity: null }), { todos: seven(5, false) });
      expect(left.container.querySelector("[data-task-bar]")).toBeNull();
      expect(left.container.querySelector("[data-row-status] [data-tally]")?.textContent).toBe("5/7");
      left.unmount();
    }
  });

  it("stays on a working row, and on a settled one whose subagents still work", () => {
    const working = view(meta({ status: "running" }), { todos: seven(6) });
    expect(working.container.querySelector("[data-task-bar]")).not.toBeNull();
    working.unmount();
    const watching = view(meta({ status: "idle", activity: null, background: { tasks: [], agents: ["s1"] } as unknown as SessionMeta["background"] }), { todos: seven(7, false) });
    expect(watching.container.querySelector("[data-task-bar]")).not.toBeNull();
  });
});

describe("the fold", () => {
  it("is open by default on every live row, and rides the fold that opens on its own", () => {
    for (const status of ["running", "watching", "waiting", "error", "paused", "queued"] as const) {
      const { container, unmount } = view(meta({ status, activity: null }), { todos: seven(3) });
      expect(trigger(container)?.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelectorAll("[data-task-fold] li")).toHaveLength(7);
      expect(container.querySelector("[data-task-fold]")?.className).toContain("collapsible-auto");
      unmount();
    }
  });

  it("closes on the bar's click without opening the thread, the person's choice", () => {
    const onOpen = vi.fn();
    const onTasksChoice = vi.fn();
    const { container } = view(meta(), { todos: seven(3) }, { onOpen, onTasksChoice });
    fireEvent.click(trigger(container)!);
    expect(onTasksChoice).toHaveBeenCalledWith(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("goes back to the default on a click that matches it", () => {
    const onTasksChoice = vi.fn();
    const { container } = view(meta(), { todos: seven(3) }, { tasksChoice: false, onTasksChoice });
    expect(trigger(container)?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger(container)!);
    expect(onTasksChoice).toHaveBeenCalledWith(undefined);
  });

  it("keeps Enter and Space on the bar off the row", () => {
    const onOpen = vi.fn();
    const { container } = view(meta(), { todos: seven(3) }, { onOpen });
    for (const key of ["Enter", " "]) fireEvent.keyDown(trigger(container)!, { key });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("lists every task at the compact size, the running one with the cursor", () => {
    const { container } = view(meta(), { todos: seven(3) });
    const list = container.querySelector("[data-task-fold] ul")!;
    expect(list.getAttribute("data-size")).toBe("compact");
    expect([...list.querySelectorAll(".task-mark")].map((m) => m.getAttribute("data-state"))).toEqual(["done", "done", "done", "active", "pending", "pending", "pending"]);
    expect(list.querySelector(".task-cursor")).not.toBeNull();
    expect(trigger(container)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a working row exactly one moving mark with its fold open", () => {
    const { container } = view(meta(), { todos: seven(3) });
    expect(container.querySelectorAll("[data-slot=spinner][data-turning]")).toHaveLength(1);
  });
});

describe("the fold's memory", () => {
  let link: FakeMetaLink;
  const ref = (id: string): BoardRowRef => ({ key: id, id, planId: null, group: "working", done: false, environmentId: "local", fallback: null, override: null });
  const digests = new BoardDigests();

  beforeEach(async () => {
    sessionStore.reset();
    link = new FakeMetaLink();
    link.metas = [wireMeta("a", { status: "running" }), wireMeta("b", { status: "running" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    digests.set("a", { todos: seven(3) });
    digests.set("b", { todos: seven(1) });
  });
  afterEach(() => sessionStore.reset());

  const board = (ids: string[]) => (
    <BoardDigestContext.Provider value={digests}>
      {ids.map((id) => (
        <MasterRow key={id} masterId="m1" rowRef={ref(id)} landed={false} host={null} onOpen={() => {}} menu={menu} />
      ))}
    </BoardDigestContext.Provider>
  );
  const barOf = (id: string) => document.querySelector<HTMLButtonElement>(`[data-menu-id='${id}'] [data-task-bar] [data-slot='collapsible-trigger']`);

  it("keeps a row the person closed closed across its unmount and remount, and each row apart", async () => {
    const { rerender } = render(board(["a", "b"]));
    await act(async () => {
      fireEvent.click(barOf("a")!);
    });
    expect(barOf("a")?.getAttribute("aria-expanded")).toBe("false");
    expect(barOf("b")?.getAttribute("aria-expanded")).toBe("true");
    // The virtualizer drops the row, then brings it back.
    rerender(board(["b"]));
    expect(barOf("a")).toBeNull();
    rerender(board(["a", "b"]));
    expect(barOf("a")?.getAttribute("aria-expanded")).toBe("false");
    expect(barOf("b")?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the task bar's preview fixture", () => {
  it("draws no bar with no tasks, 3/7 folded by hand and open by default, 5/7 paused and open, and none on the finished rows", async () => {
    const { TaskBarPreview } = await import("./board.preview");
    render(<TaskBarPreview />);
    const bars = [...document.querySelectorAll("[data-task-bar]")];
    expect(document.querySelector("[data-menu-id='fresh'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='tokens'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='tokens'] [data-tally]")).toBeNull();
    expect(document.querySelector("[data-menu-id='icons'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='icons'] [data-tally]")?.textContent).toBe("5/7");
    expect(bars.map((b) => b.querySelector("[data-bar-tally]")?.textContent)).toEqual(["3/7", "3/7", "5/7"]);
    expect(bars.map((b) => b.querySelector("[data-slot='collapsible-trigger']")?.getAttribute("aria-expanded"))).toEqual(["false", "true", "true"]);
  });
});

describe("the bar's one width", () => {
  it("reads the board's width, capped at the column less the tally and chevron, and the open list ends where it does", () => {
    const { container } = view(meta(), { todos: seven(3) });
    const bar = container.querySelector("[data-task-bar] [data-bar]")!;
    expect(bar.className).toContain("w-[min(var(--task-bar,160px),calc(100cqw-64px))]");
    expect(bar.className.split(" ")).toContain("shrink");
    expect(container.querySelector("[data-task-bar]")!.className.split(" ")).toContain("@container");
    expect(bar.className).toContain("min-w-0");
    const line = trigger(container)!;
    expect(line.className).toContain("w-fit");
    expect(line.className).toContain("max-w-[calc(100%+8px)]");
    expect(line.className.split(" ")).not.toContain("w-[calc(100%+8px)]");
    expect(line.querySelector("[data-bar-tally]")!.className).toContain("shrink-0");
    expect(container.querySelector("[data-task-fold] ul")!.className).toContain("w-[min(var(--task-bar,160px),calc(100cqw-64px))]");
  });

  it("puts the tally and the chevron right after the bar, one group at the column's start", () => {
    const { container } = view(meta(), { todos: seven(3) });
    const parts = [...trigger(container)!.children];
    expect(parts.map((el) => (el.hasAttribute("data-bar") ? "bar" : el.hasAttribute("data-bar-tally") ? "tally" : el.tagName.toLowerCase()))).toEqual(["bar", "tally", "svg"]);
    expect(parts[1]!.className).not.toContain("ml-auto");
  });

  it("is one width on every row of a board whose lists differ, the widest list's", async () => {
    const { TaskBarWidthPreview } = await import("./board.preview");
    const { fitTaskBar } = await import("./taskBarWidth");
    render(<TaskBarWidthPreview />);
    const holder = document.querySelector<HTMLElement>("[data-group]")!.parentElement!;
    const widest = fitTaskBar(["Write the project header rows with their host glyphs"], (t) => t.length * 6.4);
    expect(holder.style.getPropertyValue("--task-bar")).toBe(`${String(widest)}px`);
    const bars = [...document.querySelectorAll("[data-task-bar] [data-bar]")];
    expect(bars).toHaveLength(3);
    expect(new Set(bars.map((b) => b.className)).size).toBe(1);
    expect(bars.every((b) => holder.contains(b))).toBe(true);
    expect([...document.querySelectorAll("[data-bar-tally]")].map((t) => t.textContent)).toEqual(["1/3", "4/12", "2/5"]);
  });
});

describe("the fold following the thread", () => {
  const KEY = taskFoldKey("m1", "c1");
  /** The row with the fold memory the board gives it. */
  function Row({ m, todos }: { m: SessionMeta; todos: TodoItem[] }) {
    const [choice, setChoice] = useTaskFold("m1", "c1");
    return <MasterRowView meta={m} digest={{ todos }} agents={null} landed={false} host={null} hostGlyph={noGlyph} onOpen={() => {}} menu={menu} tasksChoice={choice} onTasksChoice={setChoice} />;
  }
  function mount(m: SessionMeta, todos = seven(3)) {
    const out = render(<Row m={m} todos={todos} />);
    return { ...out, update: (next: SessionMeta, nextTodos = todos) => out.rerender(<Row m={next} todos={nextTodos} />) };
  }
  const expanded = (c: HTMLElement) => trigger(c)?.getAttribute("aria-expanded") ?? null;
  const finished = meta({ status: "idle", activity: null });

  it("holds open a beat when the thread finishes, then folds the list and the bar line away on the auto fold, once", () => {
    vi.useFakeTimers();
    const { container, update } = mount(meta(), seven(6));
    expect(expanded(container)).toBe("true");
    update(finished, seven(7, false));
    // The frame the thread finishes never starts the fold: the last tick shows.
    expect(expanded(container)).toBe("true");
    expect(container.querySelector("[data-bar-tally]")?.textContent).toBe("7/7");
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS - 1));
    expect(expanded(container)).toBe("true");
    const outer = container.querySelector("[data-task-bar]")!.closest("[data-slot='collapsible-content']")!;
    expect(outer.className).toContain("collapsible-auto");
    expect(container.querySelector("[data-task-fold]")?.className).toContain("collapsible-auto");
    act(() => vi.advanceTimersByTime(1));
    expect(expanded(container) ?? "false").toBe("false");
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector("[data-task-bar]")).toBeNull();
    expect(taskFoldChoice(KEY)).toBeUndefined();
  });

  it("folds nothing again on a re-render that changes nothing it follows", () => {
    vi.useFakeTimers();
    const { container, update } = mount(meta(), seven(6));
    update(finished, seven(7, false));
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 3));
    expect(container.querySelector("[data-task-bar]")).toBeNull();
    update({ ...finished, title: "Renamed" }, seven(7, false));
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 3));
    expect(container.querySelector("[data-task-bar]")).toBeNull();
    // A live row's unrelated push keeps its list open.
    cleanup();
    const live = mount(meta(), seven(3));
    live.update(meta({ activity: "Reading" }), seven(4));
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 3));
    expect(expanded(live.container)).toBe("true");
  });

  it("keeps a list the person closed while working closed, through the finish and the next pass", () => {
    vi.useFakeTimers();
    const { container, update } = mount(meta());
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    expect(expanded(container)).toBe("false");
    expect(taskFoldChoice(KEY)).toBe(false);
    // A hand's move rides the hand fold, not the auto one.
    expect(container.querySelector("[data-task-fold]")?.className ?? "").not.toContain("collapsible-auto");
    update(finished);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 3));
    expect(container.querySelector("[data-task-bar]")).toBeNull();
    update(meta({ status: "running" }));
    expect(expanded(container)).toBe("false");
  });

  it("keeps a list the person opened as it folded away open, with its bar line", () => {
    vi.useFakeTimers();
    const { container, update } = mount(meta());
    update(finished);
    // Closed by hand during the beat, then opened again: the person's open on a finished row.
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 3));
    expect(taskFoldChoice(KEY)).toBe(true);
    expect(expanded(container)).toBe("true");
    expect(container.querySelectorAll("[data-task-fold] li")).toHaveLength(7);
  });

  it("opens again on its own when a finished thread starts a new pass", () => {
    vi.useFakeTimers();
    const { container, update } = mount(finished);
    expect(container.querySelector("[data-task-bar]")).toBeNull();
    update(meta({ status: "running" }));
    expect(expanded(container)).toBe("true");
    expect(container.querySelector("[data-task-fold]")?.className).toContain("collapsible-auto");
  });
});
