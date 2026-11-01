import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { agentIdOf, appView } from "./appTool";

const call = (name: string, input: unknown, detail?: string): Block => ({
  id: "b1",
  role: "tool",
  text: name,
  tool: { callId: "c1", name, input, detail, status: "completed" },
});
const titleOf = (id: string) => ({ thread1: "Auth rewrite", agent1: "Explorer" })[id];

describe("appView", () => {
  it("reads memory-only edits as an app row and real edits as nothing", () => {
    expect(appView(call("Write", { file_path: "/p/.temp-code/PROJECT.md", content: "" }), titleOf)).toEqual({
      label: "Updated",
      detail: "project memory",
      phrase: "updated project memory",
    });
    expect(appView(call("Edit", { file_path: "/p/src/a.ts" }), titleOf)).toBeNull();
    expect(appView(call("Read", { file_path: "/tmp/x-appshot.png" }), titleOf)?.detail).toBe("appshot");
  });
  it("reads report and findings writes as what they are, and a citation by its host", () => {
    expect(appView(call("Write", { file_path: "/ws/.temp-code/reports/abc123.md", content: "" }), titleOf)).toMatchObject({
      label: "Updated",
      detail: "the report",
    });
    expect(appView(call("Edit", { file_path: "/ws/.temp-code/reports/abc123/pricing-x1y2z3.md" }), titleOf)).toMatchObject({
      detail: "findings",
      phrase: "updated findings",
    });
    expect(appView(call("mcp__app__cite_source", { url: "https://www.react.dev/blog", claim: "x" }), titleOf)).toEqual({
      label: "Cited",
      detail: "react.dev",
      phrase: "cited react.dev",
    });
    expect(appView(call("cite_source", { url: "src/main/server/sessions.ts", claim: "x" }), titleOf)?.detail).toBe("sessions.ts");
  });
  it("names threads by title and links them", () => {
    expect(appView(call("mcp__app__app_read_thread", { threadId: "thread1" }), titleOf)).toEqual({
      label: "Read thread",
      detail: "Auth rewrite",
      phrase: "read thread “Auth rewrite”",
      threadId: "thread1",
    });
    expect(appView(call("app_read_thread", { threadId: "zz" }), titleOf)).toMatchObject({
      detail: "zz",
      threadId: undefined,
    });
    expect(appView(call("app_list_threads", { allProjects: true }), titleOf)?.detail).toBe("all projects");
    // The type joins the verb, the title is the detail: no middle dot between them.
    expect(appView(call("app_start_thread", { threadType: "planning" }, '{"title":"Fresh"}'), titleOf)).toMatchObject({
      label: "New planning thread",
      detail: "Fresh",
    });
  });
  it("names HTML page calls by what they showed, never by path or JSON", () => {
    expect(appView(call("mcp__app__html_preview", { html: "<p/>" }), titleOf)).toEqual({
      label: "Previewed",
      detail: "page",
      phrase: "previewed a page",
    });
    const shown = appView(
      call("app.html_render", { html: "<p/>", title: "Q3 revenue", height: 300 }, '{"htmlRender":{}}'),
      titleOf,
    );
    expect(shown).toEqual({ label: "Showed page", detail: "“Q3 revenue”", phrase: "showed page “Q3 revenue”" });
  });
  it("describes subagent calls by title or task, resolving @thread tags", () => {
    expect(agentIdOf(call("spawn_agent", {}, '{"agentId":"agent1"}'))).toBe("agent1");
    expect(appView(call("mcp__orchestrator__spawn_agent", { task: "x" }, '{"agentId":"agent1"}'), titleOf)).toMatchObject({
      label: "Spawned",
      detail: "Explorer",
      threadId: "agent1",
    });
    expect(
      appView(
        call("spawn_agent", { agents: [{ task: "a" }, { task: "b" }, { task: "c" }] }, '{"agents":[{"agentId":"agent1"}]}'),
        titleOf,
      ),
    ).toEqual({ label: "Spawned", detail: "3 agents", phrase: "spawned 3 agents" });
    expect(appView(call("send_to_agent", { agentId: "nope", message: "read @thread:thread1 first" }), titleOf)).toMatchObject({
      label: "Messaged",
      detail: "read @Auth rewrite first",
    });
    expect(appView(call("Bash", { command: "ls" }), titleOf)).toBeNull();
  });
  it("links a spawn to the child the host stamped on the call before its result lands", () => {
    const running: Block = {
      id: "b1",
      role: "tool",
      text: "spawn",
      tool: { callId: "c1", name: "spawn_agent", input: { task: "x" }, status: "running", spawned: ["agent1"] },
    };
    expect(agentIdOf(running)).toBe("agent1");
    expect(appView(running, titleOf)).toMatchObject({ label: "Spawning", detail: "Explorer", threadId: "agent1" });
    expect(appView(running, titleOf, false)).toMatchObject({ label: "Spawned", phrase: "spawned “Explorer”" });
  });
  it("speaks a running wait in the present and a settled one in the past", () => {
    const wait = call("wait_for_agent", { agentId: "agent1" });
    expect(appView(wait, titleOf)).toMatchObject({ label: "Waited for", phrase: "waited for “Explorer”" });
    expect(appView(wait, titleOf, true)).toMatchObject({ label: "Waiting for", phrase: "waiting for “Explorer”" });
  });
  it("names the app's own bookkeeping calls by what they did", () => {
    expect(appView(call("mcp__app__update_notes", { section: "State", content: "x" }), titleOf)).toEqual({
      label: "Updated",
      detail: "the notes",
      phrase: "updated the notes",
    });
    expect(appView(call("app.batch_rules", { steps: [] }), titleOf)).toEqual({
      label: "Set",
      detail: "the batch steps",
      phrase: "set the batch steps",
    });
    expect(appView(call("mcp__app__merge_branch", { branch: "ui-3" }), titleOf)).toEqual({
      label: "Merged",
      detail: "ui-3",
      phrase: "merged ui-3",
    });
    expect(appView(call("mcp__app__merge_branch", {}), titleOf, true)).toMatchObject({
      label: "Merging",
      detail: "the branch",
    });
    expect(appView(call("mcp__app__plan_complete", {}), titleOf)).toEqual({
      label: "Marked",
      detail: "the plan complete",
      phrase: "marked the plan complete",
    });
    expect(appView(call("TaskCreate", { subject: "Wire the fold" }), titleOf)).toEqual({
      label: "Added a task",
      detail: "Wire the fold",
      phrase: "added a task",
    });
    expect(appView(call("TaskUpdate", { taskId: "3", status: "completed" }), titleOf)).toEqual({
      label: "Updated a task",
      detail: "",
      phrase: "updated a task",
    });
  });
});
