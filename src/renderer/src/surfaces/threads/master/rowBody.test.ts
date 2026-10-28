import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { BoardDigest } from "@server/shared/contract-batch";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { passLine, rowStatus, summaryLine, taskInHand, taskTally } from "./rowBody";

const todos: TodoItem[] = [
  { content: "Read the brief", status: "completed" },
  { content: "Write the view", status: "in_progress" },
  { content: "Tests", status: "pending" },
];

const at = new Date(2026, 9, 27, 12, 8).getTime();
const m = (over: Partial<SessionMeta>) =>
  ({ status: "idle", activity: null, failure: null, updatedAt: at, threadType: "implementation", ...over }) as SessionMeta;

describe("the task list", () => {
  it("names the task in hand and tallies done of total", () => {
    expect(taskInHand(todos)).toBe("Write the view");
    expect(taskInHand(todos.slice(0, 1))).toBeNull();
    expect(taskTally(todos)).toBe("1/3");
    expect(taskTally([])).toBeNull();
  });

  it("the summary is the notes' State, else the last words", () => {
    expect(summaryLine({ state: "Composer done", last: "Looked." })).toBe("Composer done");
    expect(summaryLine({ last: "Looked." })).toBe("Looked.");
    expect(summaryLine({})).toBe("");
  });
});

describe("rowStatus", () => {
  it("working: an implementation's task in hand, else the activity", () => {
    expect(rowStatus(m({ status: "running", activity: "Running ios:test" }), { todos }, false)).toEqual({ state: "working", detail: "write the view" });
    expect(rowStatus(m({ status: "running", activity: "Running ios:test" }), {}, false)).toEqual({ state: "working", detail: "running ios:test" });
    expect(rowStatus(m({ status: "starting", threadType: "chat", activity: "Reading" }), { todos }, false)).toEqual({ state: "working", detail: "reading" });
  });

  it("waiting: the open question, else approve and what it was doing, with no old prefix", () => {
    expect(rowStatus(m({ status: "waiting", activity: "Running rm" }), { question: "Which build, ad hoc or debug?" }, false)).toEqual({ state: "waiting", detail: "which build, ad hoc or debug?" });
    expect(rowStatus(m({ status: "waiting", activity: "Bash" }), {}, false)).toEqual({ state: "waiting", detail: "approve Bash" });
    expect(rowStatus(m({ status: "waiting" }), {}, false)).toEqual({ state: "waiting", detail: "" });
  });

  it("failed: the digest's failure, else the meta's summary", () => {
    expect(rowStatus(m({ status: "error" }), { failure: "Rate limited until 14:00" }, false)).toEqual({ state: "failed", detail: "rate limited until 14:00" });
    expect(rowStatus(m({ status: "error", failure: { summary: "Usage cap" } as SessionMeta["failure"] }), {}, false).detail).toBe("usage cap");
  });

  it("watching and queued strip the lead their word says", () => {
    expect(rowStatus(m({ status: "watching", activity: "Waiting on 3 subagents" }), {}, false)).toEqual({ state: "watching", detail: "3 subagents" });
    expect(rowStatus(m({ status: "queued", activity: "Queued · waiting for Home" }), {}, false)).toEqual({ state: "queued", detail: "waiting for Home" });
  });

  it("paused says what it was doing, never the word again; stopped says nothing unless it blocks the batch", () => {
    expect(rowStatus(m({ status: "paused", activity: "Running bun test" }), {}, false)).toEqual({ state: "paused", detail: "running bun test" });
    expect(rowStatus(m({ status: "paused", activity: "Paused" }), {}, false)).toEqual({ state: "paused", detail: "" });
    // The host clears the activity on a pause: an implementation still says its task in hand.
    expect(rowStatus(m({ status: "paused", activity: null }), { todos }, false)).toEqual({ state: "paused", detail: "write the view" });
    expect(rowStatus(m({ status: "stopped" }), {}, false)).toEqual({ state: "stopped", detail: "" });
    expect(rowStatus(m({ status: "stopped" }), {}, false, "was stopped")).toEqual({ state: "stopped", detail: "was stopped" });
  });

  it("a child watching its own background task is watching what it watches, never working", () => {
    const background = { tasks: [{ id: "t", label: "Sleep 180 seconds in the background", kind: "shell", startedAt: 0 }], agents: [] } as unknown as SessionMeta["background"];
    expect(rowStatus(m({ status: "watching", activity: "Waiting on Sleep 180 seconds in the background", background }), {}, false)).toEqual({
      state: "watching",
      detail: "sleep 180 seconds in the background",
    });
    const agents = { tasks: [], agents: ["a", "b"] } as unknown as SessionMeta["background"];
    expect(rowStatus(m({ status: "idle", background: agents }), {}, false)).toEqual({ state: "watching", detail: "2 subagents" });
  });

  it("the child that blocks the batch says why: one that ended without completing, one that errored with no failure line", () => {
    expect(rowStatus(m({ status: "idle" }), { todos }, false, "ended its turn without completing")).toEqual({ state: "done", detail: "ended its turn without completing" });
    expect(rowStatus(m({ status: "error" }), {}, false, "errored")).toEqual({ state: "failed", detail: "errored" });
    expect(rowStatus(m({ status: "error" }), { failure: "Usage cap" }, false, "errored").detail).toBe("usage cap");
  });

  it("a detail loses its capital and its full stop", () => {
    expect(rowStatus(m({ status: "error", failure: { summary: "The Claude Code process died mid-turn." } as SessionMeta["failure"] }), {}, false).detail).toBe(
      "the Claude Code process died mid-turn",
    );
  });

  it("an idle row is done: when it landed, else a research or orchestration summary, else nothing", () => {
    expect(rowStatus(m({}), {}, true)).toEqual({ state: "done", detail: "landed 12:08" });
    expect(rowStatus(m({ threadType: "research" }), { state: "Composer done", last: "x" }, false)).toEqual({ state: "done", detail: "composer done" });
    expect(rowStatus(m({ status: "done", threadType: "orchestration" }), { last: "Looked at three sources." }, false).detail).toBe("looked at three sources");
    expect(rowStatus(m({ threadType: "chat" }), { last: "x" }, false)).toEqual({ state: "done", detail: "" });
  });
});

describe("passLine", () => {
  it("is the row's status, else its last words", () => {
    const digest = { last: "Wrote the empty state." } as BoardDigest;
    expect(passLine(m({ status: "running", activity: "Running tests", threadType: "chat" }), digest, false)).toEqual({ state: "working", detail: "running tests" });
    expect(passLine(m({ status: "waiting" }), { question: "Which icon?" } as BoardDigest, false).state).toBe("waiting");
    expect(passLine(m({ threadType: "chat" }), digest, false)).toEqual({ state: "done", detail: "Wrote the empty state." });
  });
});
