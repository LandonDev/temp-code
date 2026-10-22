import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../lib/tcserver/todos";
import { rowBody, summaryLine, taskProgress, tasksOpenByDefault, taskTally, whatLine } from "./rowBody";

describe("what a row shows under its lines, by type", () => {
  it("an implementation shows its task list; nothing before the first list", () => {
    const todos: TodoItem[] = [
      { content: "Read the brief", status: "completed" },
      { content: "Write the view", status: "in_progress" },
      { content: "Tests", status: "pending" },
    ];
    expect(rowBody({ threadType: "implementation" }, { todos })).toEqual({ kind: "tasks", tasks: todos });
    expect(rowBody({ threadType: "implementation" }, {})).toBeNull();
    expect(taskTally(todos)).toBe("1/3");
    expect(taskTally([])).toBeNull();
    expect(taskProgress(todos)).toEqual({ done: 1, total: 3 });
    expect(taskProgress([])).toBeNull();
  });

  it("the task list is open while the thread works or needs you, folded once it sits in Done", () => {
    for (const status of ["running", "starting", "watching", "paused", "waiting", "error", "queued"] as const) expect(tasksOpenByDefault(status)).toBe(true);
    for (const status of ["done", "idle", "stopped"] as const) expect(tasksOpenByDefault(status)).toBe(false);
  });

  it("research and orchestration show one summary: the notes' State line, else the last words", () => {
    expect(rowBody({ threadType: "research" }, { state: "Composer done, strip in flight", last: "Looked at three sources." })).toEqual({
      kind: "summary",
      text: "Composer done, strip in flight",
    });
    expect(rowBody({ threadType: "orchestration" }, { last: "Looked at three sources." })).toEqual({
      kind: "summary",
      text: "Looked at three sources.",
    });
    expect(summaryLine({})).toBe("");
    // A summary that is the second line already is not drawn twice.
    expect(rowBody({ threadType: "orchestration" }, { last: "Looked at three sources." }, "Looked at three sources.")).toBeNull();
    expect(rowBody({ threadType: "research" }, {})).toBeNull();
  });

  it("chat and plan rows carry nothing more, whatever they hold", () => {
    const digest = { todos: [{ content: "x", status: "pending" as const }], state: "Doing x" };
    expect(rowBody({ threadType: "chat" }, digest)).toBeNull();
    expect(rowBody({ threadType: "planning" }, digest)).toBeNull();
    expect(rowBody({ threadType: null }, digest)).toBeNull();
  });
});

describe("the second line", () => {
  const line = { text: "has a question — Ad Hoc or Debug?", tone: "warning" as const };
  const at = new Date(2026, 9, 21, 12, 8).getTime();
  it("is the activity while queued or working, the question while waiting, when it landed once done", () => {
    expect(whatLine({ status: "running", activity: "Running ios:test", updatedAt: at }, line, false)).toEqual({ text: "Running ios:test", tone: "muted" });
    expect(whatLine({ status: "queued", activity: "Queued · waiting for Home", updatedAt: at }, line, false)?.text).toBe("Queued · waiting for Home");
    expect(whatLine({ status: "waiting", activity: null, updatedAt: at }, line, false)).toEqual(line);
    expect(whatLine({ status: "paused", activity: null, updatedAt: at }, line, false)?.text).toBe("Paused");
    expect(whatLine({ status: "idle", activity: null, updatedAt: at }, line, true)?.text).toBe("Landed 12:08");
    expect(whatLine({ status: "idle", activity: null, updatedAt: at }, line, false)).toBeNull();
  });
});
