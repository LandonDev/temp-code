// @vitest-environment jsdom
/** An implementation or orchestration row on the master board carries its
 *  task bar on a third line and folds open to its task list
 *  (docs/LAYOUT.md "Master"); every other row keeps its two lines. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardDigest } from "@server/shared/contract-batch";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta, ThreadType } from "../../../lib/tcserver/types";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink, wireMeta } from "../../../test/fakeMetaLink";
import { MasterRow, MasterRowView } from "./MasterRow";
import { resetTaskFolds } from "./taskFold";
import { BoardDigestContext, BoardDigests, type BoardRowRef } from "./useMasterModel";

const seven = (done: number, inProgress = true): TodoItem[] =>
  Array.from({ length: 7 }, (_, i) => ({ content: `Task ${String(i + 1)}`, status: i < done ? "completed" : i === done && inProgress ? "in_progress" : "pending" }) as TodoItem);

const meta = (over: Partial<SessionMeta> = {}) => ({ ...wireMeta("c1"), environmentId: "local", status: "running", activity: "Editing", ...over }) as SessionMeta;
const menu = { rowsFor: () => [], onPick: () => {}, onOpenChange: () => {} };
const noGlyph = () => null;

function view(m: SessionMeta, digest: BoardDigest, extra: { tasksOpen?: boolean; onTasksOpenChange?: (open: boolean) => void; onOpen?: (id: string) => void } = {}) {
  return render(<MasterRowView meta={m} digest={digest} agents={null} landed={false} host={null} hostGlyph={noGlyph} onOpen={extra.onOpen ?? (() => {})} menu={menu} tasksOpen={extra.tasksOpen} onTasksOpenChange={extra.onTasksOpenChange} />);
}

const row = (container: HTMLElement) => container.querySelector("[data-menu-id]")!;
const trigger = (container: HTMLElement) => container.querySelector<HTMLButtonElement>("[data-task-bar] [data-slot='collapsible-trigger']");
const indicator = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-task-bar] [data-slot='progress-indicator']");

afterEach(() => {
  cleanup();
  resetTaskFolds();
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
    expect(trigger(container)?.getAttribute("aria-expanded")).toBe("false");
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

  it("goes once the row is finished, even with its fold remembered open: no tally when every task is ticked, else it ends line two", () => {
    for (const over of [{ status: "idle" }, { status: "done" }, { status: "stopped" }] as const) {
      const all = view(meta({ ...over, activity: null }), { todos: seven(7, false) }, { tasksOpen: true });
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
  it("is closed by default", () => {
    const { container } = view(meta(), { todos: seven(3) });
    expect(container.querySelector("[data-task-fold] li")).toBeNull();
  });

  it("opens on the bar's click without opening the thread", () => {
    const onOpen = vi.fn();
    const onTasksOpenChange = vi.fn();
    const { container } = view(meta(), { todos: seven(3) }, { onOpen, onTasksOpenChange });
    fireEvent.click(trigger(container)!);
    expect(onTasksOpenChange).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps Enter and Space on the bar off the row", () => {
    const onOpen = vi.fn();
    const { container } = view(meta(), { todos: seven(3) }, { onOpen });
    for (const key of ["Enter", " "]) fireEvent.keyDown(trigger(container)!, { key });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("lists every task at the compact size, the running one with the cursor", () => {
    const { container } = view(meta(), { todos: seven(3) }, { tasksOpen: true });
    const list = container.querySelector("[data-task-fold] ul")!;
    expect(list.getAttribute("data-size")).toBe("compact");
    expect([...list.querySelectorAll(".task-mark")].map((m) => m.getAttribute("data-state"))).toEqual(["done", "done", "done", "active", "pending", "pending", "pending"]);
    expect(list.querySelector(".task-cursor")).not.toBeNull();
    expect(trigger(container)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a working row exactly one moving mark with its fold open", () => {
    const { container } = view(meta(), { todos: seven(3) }, { tasksOpen: true });
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

  it("keeps a row open across its unmount and remount, and each row apart", async () => {
    const { rerender } = render(board(["a", "b"]));
    await act(async () => {
      fireEvent.click(barOf("a")!);
    });
    expect(barOf("a")?.getAttribute("aria-expanded")).toBe("true");
    expect(barOf("b")?.getAttribute("aria-expanded")).toBe("false");
    // The virtualizer drops the row, then brings it back.
    rerender(board(["b"]));
    expect(barOf("a")).toBeNull();
    rerender(board(["a", "b"]));
    expect(barOf("a")?.getAttribute("aria-expanded")).toBe("true");
    expect(barOf("b")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the task bar's preview fixture", () => {
  it("draws no bar with no tasks, 3/7 folded and open, 5/7 paused, and none on the finished rows", async () => {
    const { TaskBarPreview } = await import("./board.preview");
    render(<TaskBarPreview />);
    const bars = [...document.querySelectorAll("[data-task-bar]")];
    expect(document.querySelector("[data-menu-id='fresh'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='tokens'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='tokens'] [data-tally]")).toBeNull();
    expect(document.querySelector("[data-menu-id='icons'] [data-task-bar]")).toBeNull();
    expect(document.querySelector("[data-menu-id='icons'] [data-tally]")?.textContent).toBe("5/7");
    expect(bars.map((b) => b.querySelector("[data-bar-tally]")?.textContent)).toEqual(["3/7", "3/7", "5/7"]);
    expect(bars.map((b) => b.querySelector("[data-slot='collapsible-trigger']")?.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]);
  });
});
