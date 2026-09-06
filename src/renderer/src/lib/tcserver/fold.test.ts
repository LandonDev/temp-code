import { describe, expect, it } from "vitest";
import { toolCallLabel } from "../../surfaces/transcriptActivity";
import { emptyFold, foldAll, foldEvent, foldOptimisticUser } from "./fold";
import type { AgentEvent, EventRow } from "./types";

const CWD = "/repo";

function rows(events: (AgentEvent | [AgentEvent, Partial<EventRow>])[]): EventRow[] {
  return events.map((entry, i) => {
    const [event, extra] = Array.isArray(entry) ? entry : [entry, {}];
    return { sessionId: "s", seq: i + 1, ts: 1_000 + i * 100, event, ...extra };
  });
}

const ephemeral = (event: AgentEvent, ts = 5_000): EventRow => ({
  sessionId: "s",
  seq: -1,
  ts,
  event,
  ephemeral: true,
});

const strip = (state: ReturnType<typeof foldAll>) =>
  state.blocks.map(({ id: _id, ...rest }) => rest);

describe("foldEvent", () => {
  it("appends a user turn and opens the session", () => {
    const s = foldAll(rows([{ type: "user-text", text: "hi" }]), CWD);
    expect(s.busy).toBe(true);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ role: "user", text: "hi", startedAt: 1_000 });
    expect(s.lastSeq).toBe(1);
  });

  it("claims the optimistic user block instead of duplicating it", () => {
    let s = foldOptimisticUser(emptyFold(), "hi", [
      { id: "a1", name: "x.png", mimeType: "image/png", kind: "image", size: 3, previewUrl: "blob:x" },
    ]);
    expect(s.blocks[0].pending).toBe(true);
    s = foldEvent(
      s,
      rows([{ type: "user-text", text: "hi", attachments: [{ path: "/tmp/x.png", name: "x.png", kind: "image" }] }])[0],
      CWD,
    );
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].pending).toBeUndefined();
    expect(s.blocks[0].id).toBe("u:1");
    expect(s.blocks[0].attachments?.[0].previewUrl).toBe("blob:x");
  });

  it("streams keyed assistant text and keeps text→tool→text as two blocks", () => {
    const s = foldAll(
      rows([
        { type: "user-text", text: "go" },
        { type: "assistant-text", text: "Hel", delta: true, msgId: "m1", blockIndex: 0 },
        { type: "assistant-text", text: "lo", delta: true, msgId: "m1", blockIndex: 0 },
        { type: "tool-call", callId: "c1", name: "Read", input: { file_path: "/repo/a.ts" } },
        { type: "tool-result", callId: "c1", output: "const a = 1", isError: false },
        { type: "assistant-text", text: "Done", delta: false, msgId: "m1", blockIndex: 2 },
        { type: "assistant-text", text: "Hello", delta: false, msgId: "m1", blockIndex: 0 },
      ]),
      CWD,
    );
    const roles = s.blocks.map((b) => b.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(s.blocks[1]).toMatchObject({ text: "Hello", streaming: false });
    expect(s.blocks[3]).toMatchObject({ text: "Done", streaming: false });
  });

  it("falls back to the last streaming block when text is unkeyed", () => {
    const s = foldAll(
      rows([
        { type: "assistant-text", text: "a", delta: true },
        { type: "assistant-text", text: "b", delta: true },
        { type: "assistant-text", text: "ab", delta: false },
      ]),
      CWD,
    );
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ text: "ab", streaming: false });
  });

  it("thinking becomes a reasoning block", () => {
    const s = foldAll(rows([{ type: "thinking", text: "hmm", delta: false, msgId: "m", blockIndex: 0 }]), CWD);
    expect(s.blocks[0]).toMatchObject({ role: "reasoning", text: "hmm" });
  });

  it("tool call then result: running → completed with output detail", () => {
    let s = foldAll(
      rows([{ type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls" } }]),
      CWD,
    );
    expect(s.blocks[0]).toMatchObject({
      role: "tool",
      streaming: true,
      tool: { callId: "c1", status: "running", kind: "execute", name: "Bash" },
    });
    s = foldEvent(s, rows([{ type: "tool-result", callId: "c1", output: "a.ts\nb.ts", isError: false }])[0], CWD);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({
      streaming: false,
      tool: { status: "completed", detail: "a.ts\nb.ts" },
    });
    const failed = foldEvent(s, rows([{ type: "tool-result", callId: "c1", output: "boom", isError: true }])[0], CWD);
    expect(failed.blocks[0].tool?.status).toBe("failed");
  });

  it("a read result carries the file preview", () => {
    const s = foldAll(
      rows([
        { type: "tool-call", callId: "c", name: "Read", input: { file_path: "/repo/a.ts" } },
        { type: "tool-result", callId: "c", output: "const a = 1", isError: false },
      ]),
      CWD,
    );
    expect(s.blocks[0].text).toBe("Read a.ts");
    expect(s.blocks[0].tool?.preview).toMatchObject({ kind: "read", path: "/repo/a.ts" });
  });

  it("a codex addon call takes its display face as title", () => {
    const s = foldAll(
      rows([{ type: "tool-call", callId: "c", name: "x", input: {}, display: { app: "Linear", action: "list issues" } }]),
      CWD,
    );
    expect(s.blocks[0].text).toBe("Linear: list issues");
  });

  it("a driver-supplied preview wins over the mined one", () => {
    const s = foldAll(
      rows([{ type: "tool-call", callId: "c", name: "fx_search", input: {}, preview: { kind: "search", query: "needle" } }]),
      CWD,
    );
    expect(s.blocks[0].tool?.preview).toMatchObject({ kind: "search", query: "needle" });
  });

  it("an ephemeral partial input and its persisted final fold to one block", () => {
    const partial = ephemeral({ type: "tool-call", callId: "c1", name: "Write", input: { file_path: "/repo/x.ts" }, partial: true });
    const final: AgentEvent = { type: "tool-call", callId: "c1", name: "Write", input: { file_path: "/repo/x.ts", content: "hi" } };
    const result: AgentEvent = { type: "tool-result", callId: "c1", output: "ok", isError: false };
    const log = rows([{ type: "user-text", text: "go" }, final, result, { type: "turn-complete" }]);
    const live = foldAll([log[0], partial, partial, log[1], log[2], log[3]], CWD);
    const replay = foldAll(log, CWD);
    expect(strip(live)).toEqual(strip(replay));
    expect(live.lastSeq).toBe(4);
    expect(live.blocks).toHaveLength(2);
  });

  it("replay of a recorded turn equals the live fold with deltas", () => {
    const log = rows([
      { type: "user-text", text: "q" },
      { type: "status", status: "running" },
      { type: "thinking", text: "t", delta: true, msgId: "m", blockIndex: 0 },
      { type: "thinking", text: "t", delta: false, msgId: "m", blockIndex: 0 },
      { type: "assistant-text", text: "he", delta: true, msgId: "m", blockIndex: 1 },
      { type: "assistant-text", text: "llo", delta: true, msgId: "m", blockIndex: 1 },
      { type: "tool-call", callId: "c", name: "Grep", input: { pattern: "x" } },
      { type: "approval-request", requestId: "r1", toolName: "Grep", input: { pattern: "x" }, callId: "c" },
      { type: "approval-resolved", requestId: "r1", allow: true },
      { type: "tool-result", callId: "c", output: "y", isError: false },
      { type: "assistant-text", text: "hello", delta: false, msgId: "m", blockIndex: 1 },
      { type: "context", tokens: 1200, window: 200000 },
      { type: "turn-complete", costUsd: 0.01 },
      { type: "status", status: "idle" },
    ]);
    const live = log.reduce((acc, row) => foldEvent(acc, row, CWD), emptyFold());
    const replay = foldAll(log, CWD);
    expect(strip(live)).toEqual(strip(replay));
    expect(replay.busy).toBe(false);
    expect(replay.context).toEqual({ used: 1200, window: 200000 });
    expect(replay.blocks.map((b) => b.role)).toEqual(["user", "reasoning", "assistant", "tool"]);
    expect(replay.blocks[3].approval).toEqual({ requestId: "r1", decided: "allow" });
    expect(replay.blocks[0].durationMs).toBe(1_200);
  });

  describe("approvals", () => {
    it("attaches by callId", () => {
      const s = foldAll(
        rows([
          { type: "tool-call", callId: "c1", name: "Bash", input: { command: "rm x" } },
          { type: "approval-request", requestId: "r", toolName: "Bash", input: { command: "rm x" }, callId: "c1" },
        ]),
        CWD,
      );
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].approval).toEqual({ requestId: "r" });
      expect(s.busy).toBe(true);
    });

    it("attaches to the only undecided tool block when the id is missing", () => {
      const s = foldAll(
        rows([
          { type: "tool-call", callId: "c1", name: "mcp__app__app_list_threads", input: {} },
          { type: "approval-request", requestId: "a-1", toolName: "mcp__app__app_list_threads", input: {}, title: "app: list threads" },
        ]),
        CWD,
      );
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].approval?.requestId).toBe("a-1");
    });

    it("attaches to the latest call of the same tool when the id is missing", () => {
      const s = foldAll(
        rows([
          { type: "tool-call", callId: "c1", name: "Read", input: { file_path: "a" } },
          { type: "tool-call", callId: "c2", name: "Bash", input: { command: "ls" } },
          { type: "tool-call", callId: "c3", name: "mcp__app__app_list_threads", input: {} },
          { type: "approval-request", requestId: "a-1", toolName: "mcp__app__app_list_threads", input: { allProjects: false }, title: "app: list threads" },
        ]),
        CWD,
      );
      expect(s.blocks).toHaveLength(3);
      expect(s.blocks[2].approval?.requestId).toBe("a-1");
      expect(s.blocks[2].tool?.name).toBe("mcp__app__app_list_threads");
      expect(toolCallLabel(s.blocks[2], CWD)).toBe("Using List Threads");
    });

    it("appends its own block when nothing matches", () => {
      const s = foldAll(
        rows([
          { type: "tool-call", callId: "c1", name: "Read", input: { file_path: "a" } },
          { type: "tool-call", callId: "c2", name: "Read", input: { file_path: "b" } },
          { type: "approval-request", requestId: "r", toolName: "Bash", input: { command: "ls" } },
        ]),
        CWD,
      );
      expect(s.blocks).toHaveLength(3);
      expect(s.blocks[2]).toMatchObject({ role: "tool", approval: { requestId: "r" } });
      expect(toolCallLabel(s.blocks[2], CWD)).toBe("Listing files");
    });

    it("resolves deny and auto-cancel", () => {
      const base = rows([{ type: "approval-request", requestId: "r", toolName: "Bash", input: {} }]);
      const deny = foldAll([...base, ...rows([{ type: "approval-resolved", requestId: "r", allow: false }]).map((r) => ({ ...r, seq: 2 }))], CWD);
      expect(deny.blocks[0].approval?.decided).toBe("deny");
      const auto = foldAll([...base, { ...base[0], seq: 2, event: { type: "approval-resolved", requestId: "r", allow: false, auto: true } }], CWD);
      expect(auto.blocks[0].approval?.decided).toBe("cancelled");
    });
  });

  it("questions become a tool block with question meta and settle on answer", () => {
    const q: AgentEvent = {
      type: "question-request",
      requestId: "q1",
      questions: [{ question: "Which?", header: "Auth", options: [{ label: "A" }, { label: "B" }] }],
    };
    let s = foldAll(rows([q]), CWD);
    expect(s.blocks[0]).toMatchObject({ role: "tool", text: "Auth", question: { sessionId: "s", requestId: "q1" }, tool: { kind: "question", status: "running" } });
    expect(s.busy).toBe(true);
    s = foldEvent(s, rows([{ type: "question-resolved", requestId: "q1", answers: [["A"]] }])[0], CWD);
    expect(s.blocks[0].question?.answers).toEqual([["A"]]);
    expect(s.blocks[0].tool?.status).toBe("completed");
  });

  it("a question attaches to its own tool call and settles with its result", () => {
    let s = foldAll(
      rows([
        { type: "tool-call", callId: "t1", name: "AskUserQuestion", input: {} },
        { type: "question-request", requestId: "q-t1", callId: "t1", questions: [{ question: "Pick", options: [{ label: "a" }] }] },
      ]),
      CWD,
    );
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ tool: { callId: "t1", kind: "question", status: "running" }, question: { requestId: "q-t1" } });
    s = foldEvent(s, rows([{ type: "question-resolved", requestId: "q-t1", answers: [["a"]] }])[0], CWD);
    s = foldEvent(s, rows([{ type: "tool-result", callId: "t1", output: "ok", isError: false }])[0], CWD);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0].tool?.status).toBe("completed");
    expect(s.blocks[0].question?.answers).toEqual([["a"]]);
  });

  it("status drives busy and detail becomes a deduped system line", () => {
    let s = foldAll(rows([{ type: "status", status: "starting" }]), CWD);
    expect(s.busy).toBe(true);
    s = foldEvent(s, rows([{ type: "status", status: "running", detail: "Compacting" }])[0], CWD);
    s = foldEvent(s, rows([{ type: "status", status: "running", detail: "Compacting" }])[0], CWD);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ role: "system", text: "Compacting" });
    s = foldEvent(s, rows([{ type: "status", status: "waiting", detail: "awaiting approval" }])[0], CWD);
    expect(s.blocks).toHaveLength(1);
    s = foldEvent(s, rows([{ type: "status", status: "idle" }])[0], CWD);
    expect(s.busy).toBe(false);
  });

  it("errors append a system line, stopped clears busy, errors-cleared drops them", () => {
    let s = foldAll(
      rows([
        { type: "user-text", text: "x" },
        { type: "assistant-text", text: "partial", delta: true, msgId: "m", blockIndex: 0 },
        { type: "error", message: "turn ended: stopped", stopped: true },
      ]),
      CWD,
    );
    expect(s.busy).toBe(false);
    expect(s.blocks[1].streaming).toBe(false);
    expect(s.blocks[2]).toMatchObject({ role: "system", text: "turn ended: stopped" });
    s = foldEvent(s, rows([{ type: "errors-cleared" }])[0], CWD);
    expect(s.blocks).toHaveLength(2);
  });

  it("compaction, plan, and orchestration markers", () => {
    const s = foldAll(
      rows([
        { type: "compaction", phase: "start" },
        { type: "compaction", phase: "done" },
        { type: "plan", text: "# Plan" },
        { type: "turn-pass", actions: ["test"] },
        { type: "agent-report", agentId: "a", title: "Child", status: "done" },
        { type: "agent-spawned", childSessionId: "k" },
        { type: "goal", phase: "set", condition: "tests pass" },
        { type: "usage", inputTokens: 1 },
      ]),
      CWD,
    );
    expect(s.blocks.map((b) => [b.role, b.text])).toEqual([
      ["system", "Context compacted"],
      ["plan", "# Plan"],
      ["system", "Pass: test"],
      ["system", "Agent Child: done"],
      ["system", "Spawned agent k"],
      ["system", "Goal set: tests pass"],
    ]);
  });

  it("subagent prose stays out of the flow; its tool calls show", () => {
    const s = foldAll(
      rows([
        { type: "assistant-text", text: "inner", delta: false, parentCallId: "task1" },
        { type: "tool-call", callId: "c", name: "Read", input: { file_path: "a" }, parentCallId: "task1" },
      ]),
      CWD,
    );
    expect(s.blocks.map((b) => b.role)).toEqual(["tool"]);
  });

  it("returns the same state for a no-op row", () => {
    const s = foldAll(rows([{ type: "status", status: "idle" }]), CWD);
    const again = foldEvent(s, ephemeral({ type: "usage" }), CWD);
    expect(again).toBe(s);
  });
});

describe("thread state", () => {
  const todoWrite = (callId: string, todos: { content: string; status: string }[]): AgentEvent => ({
    type: "tool-call",
    callId,
    name: "TodoWrite",
    input: { todos },
  });

  it("stamps blocks with round and todo, and keeps the time", () => {
    const s = foldAll(
      rows([
        { type: "user-text", text: "go" },
        todoWrite("t1", [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }]),
        { type: "tool-call", callId: "c1", name: "Read", input: { file_path: "/repo/a.ts" } },
        { type: "tool-result", callId: "c1", output: "x", isError: false },
        todoWrite("t2", [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }]),
        { type: "assistant-text", text: "done", delta: false, msgId: "m", blockIndex: 0 },
        { type: "turn-complete", costUsd: 0.5, inputTokens: 10, outputTokens: 4 },
      ]),
      CWD,
    );
    expect(s.blocks.map((b) => [b.round, b.todo])).toEqual([
      [0, -1],
      [0, 0],
      [0, 0],
      [0, 1],
      [0, 1],
    ]);
    expect(s.blocks[0].ts).toBe(1_000);
    expect(s.blocks[0].doneTs).toBe(1_600);
    expect(s.blocks[2].doneTs).toBe(1_300);
    expect(s.thread.todos).toEqual([
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
    expect(s.thread.cost).toBe(0.5);
    expect(s.thread.usage).toEqual([{ round: 0, todo: 1, input: 10, output: 4 }]);
    expect(s.thread.turnOpen).toBe(false);
  });

  it("TaskCreate learns its id from the result and TaskUpdate moves it by #n", () => {
    const s = foldAll(
      rows([
        { type: "user-text", text: "go" },
        { type: "tool-call", callId: "k1", name: "TaskCreate", input: { subject: "Write tests" } },
        { type: "tool-result", callId: "k1", output: "Task #7 created successfully", isError: false },
        { type: "tool-call", callId: "k2", name: "TaskCreate", input: { subject: "Ship" } },
        { type: "tool-result", callId: "k2", output: "Task #8 created", isError: false },
        { type: "tool-call", callId: "k3", name: "TaskUpdate", input: { taskId: "8", status: "in_progress" } },
        { type: "tool-result", callId: "k3", output: "ok", isError: false },
        { type: "tool-call", callId: "k3", name: "TaskUpdate", input: { taskId: "8", status: "in_progress" } },
      ]),
      CWD,
    );
    expect(s.thread.todos).toEqual([
      { content: "Write tests", status: "pending" },
      { content: "Ship", status: "in_progress" },
    ]);
    expect(s.thread.activeTodo).toBe(1);
    expect(s.thread.taskIds).toEqual({ "7": 0, "8": 1 });
  });

  it("a follow-up after a finished pass archives the list as a round", () => {
    const s = foldAll(
      rows([
        { type: "user-text", text: "one" },
        todoWrite("t1", [{ content: "A", status: "completed" }]),
        { type: "turn-complete", costUsd: 0.2 },
        { type: "user-text", text: "two" },
        todoWrite("t2", [{ content: "B", status: "in_progress" }]),
      ]),
      CWD,
    );
    expect(s.thread.round).toBe(1);
    expect(s.thread.rounds).toEqual([[{ content: "A", status: "completed" }]]);
    expect(s.thread.costs).toEqual([0.2]);
    expect(s.thread.todos).toEqual([{ content: "B", status: "in_progress" }]);
    expect(s.blocks[3].round).toBe(1);
  });

  it("a warm message resumes an unfinished pass; an explicit newPass does not", () => {
    const base = rows([
      { type: "user-text", text: "one" },
      todoWrite("t1", [{ content: "A", status: "in_progress" }]),
      { type: "error", message: "boom", stopped: true },
      { type: "status", status: "idle" },
    ]);
    const resumed = foldAll(
      [...base, { sessionId: "s", seq: 5, ts: 1_500, event: { type: "user-text", text: "continue" } }],
      CWD,
    );
    expect(resumed.thread.round).toBe(0);
    expect(resumed.thread.todos).toHaveLength(1);
    expect(resumed.thread.stopped).toBe(false);
    const fresh = foldAll(
      [...base, { sessionId: "s", seq: 5, ts: 1_500, event: { type: "user-text", text: "next", newPass: true } as AgentEvent }],
      CWD,
    );
    expect(fresh.thread.round).toBe(1);
    expect(fresh.thread.todos).toHaveLength(0);
  });

  it("a stale open turn does not swallow the next request", () => {
    const s = foldAll(
      [
        ...rows([{ type: "user-text", text: "one" }, todoWrite("t1", [{ content: "A", status: "completed" }])]),
        { sessionId: "s", seq: 3, ts: 1_100 + 11 * 60_000, event: { type: "user-text", text: "later" } },
      ],
      CWD,
    );
    expect(s.thread.round).toBe(1);
  });

  it("the optimistic user turn opens the round the echo then claims", () => {
    let s = foldAll(rows([{ type: "user-text", text: "one" }, { type: "turn-complete" }]), CWD);
    s = foldOptimisticUser(s, "two", [], undefined, true);
    expect(s.thread.round).toBe(1);
    expect(s.blocks[1].round).toBe(1);
    s = foldEvent(s, { sessionId: "s", seq: 3, ts: 2_000, event: { type: "user-text", text: "two" } }, CWD);
    expect(s.blocks).toHaveLength(2);
    expect(s.thread.round).toBe(1);
    expect(s.blocks[1].ts).toBe(2_000);
  });

  it("keeps research sources whole and the spawned agents", () => {
    const s = foldAll(
      rows([
        { type: "research-source", callId: "r1", query: "bun sqlite", agentId: "a1", agentLabel: "Explorer 1" },
        { type: "research-source", callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1" },
        { type: "research-source", callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1", title: "Bun docs" },
        { type: "agent-spawned", childSessionId: "a1" },
        { type: "agent-spawned", childSessionId: "a1" },
      ]),
      CWD,
    );
    expect(s.thread.sources).toHaveLength(2);
    expect(s.thread.sources[1]).toMatchObject({ url: "https://bun.sh/docs", title: "Bun docs", ts: 1_100 });
    expect(s.thread.agents).toEqual(["a1"]);
    expect(s.blocks.filter((b) => b.text.startsWith("Source:"))).toHaveLength(0);
  });

  it("blocks born after a turn-pass carry the pass flag until the turn ends", () => {
    const s = foldAll(
      rows([
        { type: "user-text", text: "go" },
        { type: "turn-complete" },
        { type: "turn-pass", actions: ["test"] },
        { type: "tool-call", callId: "c", name: "Bash", input: { command: "bun test" } },
        { type: "status", status: "idle" },
        { type: "user-text", text: "again" },
      ]),
      CWD,
    );
    expect(s.blocks.map((b) => !!b.pass)).toEqual([false, false, true, false]);
  });

  it("a no-op row leaves the thread state untouched", () => {
    const s = foldAll(rows([{ type: "user-text", text: "go" }]), CWD);
    const again = foldEvent(s, ephemeral({ type: "tool-call", callId: "c", name: "Read", input: {}, partial: true }), CWD);
    expect(again.thread).toBe(s.thread);
  });
});
