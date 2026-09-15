import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import type { SlashCommand } from "../lib/tcserver/types";
import { agentProviderOf, commandParts, isAgentCall, mcpServerOf } from "./toolMarks";

const call = (name: string, input: Record<string, unknown> = {}): Block => ({
  id: "t",
  role: "tool",
  text: name,
  tool: { name, input },
});

describe("agentProviderOf", () => {
  it("in-harness Agent/Task runs on claude; fleet calls read the input, then the spawned session", () => {
    expect(agentProviderOf(call("Task"))).toBe("claude");
    expect(agentProviderOf(call("mcp__orchestrator__spawn_agent", { model: "gpt-6-astra" }))).toBe("codex");
    expect(agentProviderOf(call("spawn_agent", { provider: "cursor" }))).toBe("cursor");
    expect(agentProviderOf(call("send_to_agent", { agentId: "a" }), "codex")).toBe("codex");
    expect(agentProviderOf(call("Read"))).toBeNull();
    expect(isAgentCall(call("wait_for_agent"))).toBe(true);
  });
});

describe("mcpServerOf", () => {
  it("reads the server between mcp__ and the tool's own name", () => {
    expect(mcpServerOf("mcp__linear__create_issue")).toBe("linear");
    expect(mcpServerOf("mcp__cosmic-admin__server_status")).toBe("cosmic-admin");
  });
  it("keeps a server name that itself carries underscores whole", () => {
    expect(mcpServerOf("mcp__claude_ai_Gmail__search_threads")).toBe("claude_ai_Gmail");
  });
  it("is null for a non-MCP tool", () => {
    expect(mcpServerOf("Bash")).toBeNull();
    expect(mcpServerOf("Read")).toBeNull();
  });
});

describe("commandParts", () => {
  const commands = [
    { name: "linear", source: "mcp" },
    { name: "commit", source: "skill" },
  ] as SlashCommand[];
  it("chips only the commands the session knows", () => {
    expect(commandParts("/linear list my issues", commands)).toEqual([
      { command: commands[0] },
      { text: " list my issues" },
    ]);
    expect(commandParts("run /commit then /nope", commands)).toEqual([
      { text: "run " },
      { command: commands[1] },
      { text: " then /nope" },
    ]);
    expect(commandParts("a/b path", commands)).toEqual([{ text: "a/b path" }]);
    expect(commandParts("plain", [])).toEqual([{ text: "plain" }]);
  });
});
