import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { commonDir, editVerbOf, groupPhrase } from "./groupPhrase";

const CWD = "/Users/me/monocode";

function call(
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> & { id?: string; streaming?: boolean } = {},
): Block {
  const { id, streaming, ...tool } = extra;
  return {
    id: id ?? name,
    role: "tool",
    text: name,
    streaming: streaming ?? false,
    tool: { callId: id ?? name, title: name, status: "completed", name, input, ...tool },
  };
}

const read = (p: string, id = p) => call("Read", { file_path: `${CWD}/${p}` }, { id });
const edit = (p: string, id = `e:${p}`) =>
  call("Edit", { file_path: `${CWD}/${p}`, old_string: "a", new_string: "b" }, { id });
const write = (p: string, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
  call("Write", { file_path: `${CWD}/${p}`, content: "x" }, { id: `w:${p}`, ...extra });
const bash = (command: string, id = command) => call("Bash", { command }, { id });
const grep = (pattern: string) => call("Grep", { pattern }, { id: `g:${pattern}` });

describe("groupPhrase", () => {
  it("words what ran: a refused call is the red figure's, and a run refused whole says what it asked", () => {
    const deny = (b: Block): Block => ({ ...b, approval: { requestId: b.id, decided: "deny" }, tool: { ...b.tool!, status: "failed" } });
    expect(groupPhrase([read("src/a.ts"), deny(write("notes.txt"))], CWD)).toBe("Read a.ts");
    expect(groupPhrase([deny(write("notes.txt"))], CWD)).toBe("Create notes.txt");
    expect(groupPhrase([deny(bash("npm test", "b1")), deny(bash("git status", "b2"))], CWD)).not.toMatch(/^Ran /);
  });

  it("joins phrases with commas, the first capitalized, the rest lowercase", () => {
    expect(groupPhrase([write("src/diag.ts"), bash("make")], CWD)).toBe("Created diag.ts, ran a command");
    expect(
      groupPhrase([read("src/lib/a.ts"), read("src/lib/b.ts"), read("src/lib/c.ts"), edit("src/types.ts")], CWD),
    ).toBe("Read 3 files in src/lib, edited types.ts");
  });

  it("says three phrases, then how many more", () => {
    expect(
      groupPhrase([read("a.ts"), edit("b.ts"), grep("token"), call("mcp__app__app_start_thread", {})], CWD),
    ).toBe("Read a.ts, edited b.ts, searched for token and 1 more");
  });

  it("speaks in the present tense while live", () => {
    expect(groupPhrase([write("src/diag.ts"), bash("npm test")], CWD, true)).toBe(
      "Creating diag.ts, running the tests",
    );
  });

  it("says a repeated phrase once", () => {
    expect(groupPhrase([read("a.ts"), bash("npm test", "t1"), read("a.ts", "again"), bash("npm test", "t2")], CWD)).toBe(
      "Read a.ts, ran the tests",
    );
  });

  it("folds reads by folder or project, by basename for one", () => {
    expect(groupPhrase([read("src/lib/a.ts"), read("README.md")], CWD)).toBe("Read monocode files");
    expect(groupPhrase([read("src/a.ts"), read("src/a.ts", "again")], CWD)).toBe("Read a.ts");
    expect(groupPhrase([read("a.ts"), call("Read", { file_path: "/etc/hosts" })], CWD)).toBe("Read 2 files");
  });

  it("folds edits per verb: created, edited, deleted", () => {
    expect(groupPhrase([edit("a.ts"), edit("b.ts"), edit("c.ts")], CWD)).toBe("Edited 3 files");
    expect(groupPhrase([write("a.ts"), edit("b.ts")], CWD)).toBe("Created a.ts, edited b.ts");
    const remove = call("Delete", {}, { id: "d", kind: "delete", preview: { kind: "write", path: `${CWD}/old.ts` } });
    expect(groupPhrase([remove], CWD)).toBe("Deleted old.ts");
  });

  it("counts a stretch of commands or searches", () => {
    expect(groupPhrase([bash("ls"), bash("pwd"), bash("whoami")], CWD)).toBe("Ran 3 commands");
    expect(groupPhrase([grep("a"), grep("b")], CWD)).toBe("Ran 2 searches");
  });

  it("never prints a failure count or a separator dot", () => {
    const failed = call("Bash", { command: "npm test" }, { status: "failed" });
    expect(groupPhrase([failed], CWD)).toBe("Ran the tests");
    expect(groupPhrase([bash("git status && npm test && bun run build")], CWD)).not.toMatch(/·|\+\d/);
  });

  it("says one clause for a command of two, so its parts never read as two calls", () => {
    expect(groupPhrase([read("a.ts"), bash("git status && npm test")], CWD)).toBe("Read a.ts, checked git status");
    expect(groupPhrase([bash("git status && npm test")], CWD, true)).toBe("Checking git status");
  });

  it("keeps a described command whole, commas and all", () => {
    const described = call("Bash", { command: "make", description: "Run the build, then sign" }, { id: "d" });
    expect(groupPhrase([described], CWD)).toBe("Ran the build, then sign");
  });

  it("ignores non-tool blocks and falls back for a call it cannot name", () => {
    expect(groupPhrase([{ id: "p", role: "assistant", text: "hi" }])).toBe("");
    expect(
      groupPhrase([{ id: "x", role: "tool", text: "Working", tool: { kind: "other", title: "Working" } }]),
    ).toBe("Ran 1 tool");
  });
});

describe("editVerbOf", () => {
  it("is create only for a file that did not exist before", () => {
    expect(editVerbOf(write("a.ts"))).toBe("create");
    expect(editVerbOf(write("a.ts", { detail: "The file /x/a.ts has been updated successfully." }))).toBe("edit");
    expect(editVerbOf(edit("a.ts"))).toBe("edit");
  });
});

describe("commonDir", () => {
  it("is the shared folder, empty at the root", () => {
    expect(commonDir(["src/lib/a.ts", "src/lib/b/c.ts"])).toBe("src/lib");
    expect(commonDir(["a.ts", "src/b.ts"])).toBe("");
  });
});

describe("groupPhrase: agent work and the host's steps", () => {
  const titles: Record<string, string> = { a: "Port the view", b: "Fix the fold", c: "Write the docs", t: "UI 3: subagent spawns" };
  const titleOf = (id: string) => titles[id];
  const orch = (name: string, input: unknown, id: string, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
    call(`mcp__orchestrator__${name}`, input, { id, ...extra });
  const spawn = (agent: string, id = `s:${agent}`) => orch("spawn_agent", { task: "x" }, id, { spawned: [agent] });
  const sys = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, role: "system", text, ...extra });
  const report = (agent: string, status = "done") => sys(`r:${agent}`, "", { agent: { id: agent, title: "?", status } });
  const say = (blocks: Block[], live?: boolean) => groupPhrase(blocks, CWD, live, titleOf);

  it("spawn_agent: one by title, a stretch by count", () => {
    expect(say([spawn("a")])).toBe("Spawned “Port the view”");
    expect(say([spawn("a")], true)).toBe("Spawning “Port the view”");
    expect(say([spawn("a"), spawn("b"), spawn("c")])).toBe("Spawned 3 agents");
    expect(say([orch("spawn_agent", { agents: [{}, {}, {}] }, "m")])).toBe("Spawned 3 agents");
  });

  it("app_start_thread", () => {
    const start = (id: string, title?: string) => call("mcp__app__app_start_thread", { threadType: "planning", title }, { id });
    expect(say([start("1", "UI 3: subagent spawns")])).toBe("Started thread “UI 3: subagent spawns”");
    expect(say([start("1", "A"), start("2", "B"), start("3", "C"), start("4", "D")])).toBe("Started 4 threads");
    expect(say([start("1", "A")], true)).toBe("Starting thread “A”");
  });

  it("send, wait, check, answer, interrupt", () => {
    expect(say([orch("send_to_agent", { agentId: "a" }, "1")])).toBe("Messaged “Port the view”");
    expect(say([orch("send_to_agent", { agentId: "a" }, "1"), orch("send_to_agent", { agentId: "b" }, "2")])).toBe("Messaged 2 agents");
    expect(say([orch("wait_for_agent", { agentId: "a" }, "1")])).toBe("Waited for “Port the view”");
    expect(say([orch("wait_for_agent", { agentId: "a" }, "1")], true)).toBe("Waiting for “Port the view”");
    expect(say([orch("wait_for_agent", { agentId: "a" }, "1"), orch("wait_for_agent", { agentId: "b" }, "2")])).toBe("Waited for 2 agents");
    expect(say([orch("check_agent", { agentId: "a" }, "1"), orch("check_agent", { agentId: "b" }, "2"), orch("check_agent", { agentId: "c" }, "3")])).toBe(
      "Checked 3 agents",
    );
    expect(say([orch("answer_agent", { agentId: "a" }, "1")])).toBe("Answered “Port the view”");
    expect(say([orch("interrupt_agent", { agentId: "a" }, "1"), orch("interrupt_agent", { agentId: "b" }, "2")])).toBe("Stopped 2 agents");
    // The same agent waited on twice is one target.
    expect(say([orch("wait_for_agent", { agentId: "a" }, "1"), orch("wait_for_agent", { agentId: "a" }, "2")])).toBe("Waited for “Port the view”");
  });

  it("a report is heard from; the batch's report reads as the batch", () => {
    expect(say([report("a")])).toBe("Heard from “Port the view”");
    expect(say([report("a"), report("b"), report("c")])).toBe("Heard from 3 agents");
    expect(say([sys("rb", "", { agent: { id: "self", title: "Batch", status: "done", batch: true } })])).toBe("Heard from the batch");
  });

  it("a master's run reads as one line", () => {
    expect(say([spawn("a"), orch("wait_for_agent", { agentId: "a" }, "w"), report("a")])).toBe(
      "Spawned “Port the view”, waited for “Port the view”, heard from “Port the view”",
    );
  });

  it("the app's bookkeeping is said once", () => {
    const notes = (id: string) => call("mcp__app__update_notes", { section: "State" }, { id });
    expect(say([notes("1"), notes("2")])).toBe("Updated the notes");
    expect(say([call("app.batch_rules", { steps: [] }, { id: "b" })])).toBe("Set the batch steps");
    expect(say([call("mcp__app__plan_complete", {}, { id: "p" })])).toBe("Marked the plan complete");
    const todo = (id: string) => call("TodoWrite", { todos: [] }, { id });
    expect(say([todo("1"), todo("2")])).toBe("Updated todos");
  });

  it("merge_branch by branch, a stretch by count", () => {
    const merge = (branch: string) => call("mcp__app__merge_branch", { branch }, { id: `m:${branch}` });
    expect(say([merge("ui-3")])).toBe("Merged ui-3");
    expect(say([merge("ui-3")], true)).toBe("Merging ui-3");
    expect(say([merge("ui-3"), merge("ui-4")])).toBe("Merged 2 branches");
  });

  it("TaskCreate and TaskUpdate", () => {
    const create = (id: string) => call("TaskCreate", { subject: "x" }, { id });
    const update = (id: string) => call("TaskUpdate", { taskId: id }, { id: `u${id}` });
    expect(say([create("1")])).toBe("Added a task");
    expect(say([create("1"), create("2"), create("3")])).toBe("Added 3 tasks");
    expect(say([update("1"), update("2"), update("3"), update("4")])).toBe("Updated 4 tasks");
  });

  it("a finished background task", () => {
    const task = (id: string, status: "completed" | "failed" | "stopped" = "completed") =>
      sys(id, "lint", { task: { id, label: "lint", status } });
    expect(say([task("1")])).toBe("Lint finished");
    expect(say([task("1", "failed")])).toBe("Lint failed");
    expect(say([task("1"), task("2")])).toBe("2 tasks finished");
  });

  it("gate, review, pass, check, hand-off, batch merge", () => {
    const gate = (ok: boolean, step: "gate" | "release" | "typecheck" = "gate") =>
      sys(`g${ok}${step}`, "", { gate: { step, branch: "ui-3", ok, log: "", at: 0 } });
    expect(say([gate(true)])).toBe("Gate passed");
    expect(say([gate(false)])).toBe("Gate failed on ui-3");
    expect(say([gate(true, "release")])).toBe("Release passed");
    const review = (outcome: "pass" | "timeout") =>
      sys(outcome, "", {
        review: { runId: "r", provider: "codex", model: "m", outcome, branch: "b", target: "master", blocking: [], minor: [], merged: true, pushed: false },
      });
    expect(say([review("pass")])).toBe("Review passed");
    expect(say([review("timeout")])).toBe("Review timed out");
    expect(say([sys("p", "Pass: Notes")])).toBe("Ran the pass");
    expect(say([sys("c", "Checking background tasks", { backgroundCheck: true })])).toBe("Checked background tasks");
    expect(say([sys("h", "Implementation started: T", { planHandoff: { id: "x", title: "T", how: "auto" } })])).toBe("Started the build");
    expect(say([sys("m", "Merged by the batch: ui-3", { notice: { kind: "batch" } })])).toBe("Merged by the batch");
  });

  it("a wake: two reports, a task, then calls", () => {
    expect(
      say([report("a"), report("b"), sys("t", "", { task: { id: "t", label: "deploy", status: "completed" } }), bash("git log")]),
    ).toBe("Heard from 2 agents, deploy finished, read git history");
  });
});
