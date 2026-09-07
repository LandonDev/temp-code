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
    expect(appView(call("app_start_thread", { threadType: "chat" }, '{"title":"Fresh"}'), titleOf)?.detail).toBe(
      "Fresh · chat",
    );
  });
  it("describes subagent calls by title or task, resolving @thread tags", () => {
    expect(agentIdOf(call("spawn_agent", {}, '{"agentId":"agent1"}'))).toBe("agent1");
    expect(appView(call("mcp__orchestrator__spawn_agent", { task: "x" }, '{"agentId":"agent1"}'), titleOf)).toMatchObject({
      label: "Spawned",
      detail: "Explorer",
      threadId: "agent1",
    });
    expect(appView(call("send_to_agent", { agentId: "nope", message: "read @thread:thread1 first" }), titleOf)).toMatchObject({
      label: "Messaged",
      detail: "read @Auth rewrite first",
    });
    expect(appView(call("Bash", { command: "ls" }), titleOf)).toBeNull();
  });
});
