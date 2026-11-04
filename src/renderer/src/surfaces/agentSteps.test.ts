import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { isOpenWait, isWaitCall, openWaitOf, waitIds, waitOutcomes } from "./agentSteps";

const wait = (input: unknown, status: string, detail?: string, name = "mcp__orchestrator__wait_for_agent"): Block => ({
  id: `w-${status}`,
  role: "tool",
  text: name,
  tool: { callId: "c1", name, input, detail, status },
});
const prose = (text: string): Block => ({ id: "p", role: "assistant", text });
const thought = (text: string): Block => ({ id: "t", role: "reasoning", text });
const bash = (status: string): Block => ({ id: "b", role: "tool", text: "Bash", tool: { callId: "c2", name: "Bash", input: { command: "ls" }, status } });

describe("wait calls", () => {
  it("knows a wait from any harness, open or settled", () => {
    expect(isWaitCall(wait({}, "running"))).toBe(true);
    expect(isWaitCall(wait({}, "completed", undefined, "app.wait_for_agent"))).toBe(true);
    expect(isWaitCall(wait({}, "completed", undefined, "wait_for_agent"))).toBe(true);
    expect(isWaitCall(bash("running"))).toBe(false);
    expect(isOpenWait(wait({}, "running"))).toBe(true);
    expect(isOpenWait(wait({}, "completed"))).toBe(false);
  });

  it("names its agents, many then one, once each", () => {
    expect(waitIds(wait({ agentId: "a" }, "running"))).toEqual(["a"]);
    expect(waitIds(wait({ agentIds: ["a", "b"], agentId: "a" }, "running"))).toEqual(["a", "b"]);
    expect(waitIds(wait({}, "running"))).toEqual([]);
  });
});

describe("waitOutcomes", () => {
  it("is nothing while open", () => {
    expect(waitOutcomes(wait({ agentId: "a" }, "running", '{"agentId":"a","status":"idle"}'))).toEqual([]);
  });

  it("reads one settled agent", () => {
    expect(waitOutcomes(wait({ agentId: "a" }, "completed", '{"agentId":"a","status":"idle","reply":"done"}'))).toEqual([{ id: "a", status: "idle" }]);
  });

  it("reads mode all's array, dropping the ones still out", () => {
    const detail = JSON.stringify([
      { agentId: "a", status: "done", reply: "x" },
      { agentId: "b", status: "timeout", note: "still running" },
      { agentId: "env_mac:c", status: "failed" },
      { agentId: "d", status: "refused", note: "no" },
    ]);
    expect(waitOutcomes(wait({ agentIds: ["a", "b"] }, "completed", detail))).toEqual([
      { id: "a", status: "done" },
      { id: "env_mac:c", status: "failed" },
    ]);
  });

  it("leaves nothing for a steer, an abort, a timeout, a refusal or a malformed answer", () => {
    expect(waitOutcomes(wait({}, "completed", '{"status":"steered","message":"hi"}'))).toEqual([]);
    expect(waitOutcomes(wait({}, "completed", '{"status":"aborted","note":"the turn ended"}'))).toEqual([]);
    expect(waitOutcomes(wait({}, "completed", '{"status":"timeout","note":"still running"}'))).toEqual([]);
    expect(waitOutcomes(wait({}, "completed", "refused: a is not a subagent of this session"))).toEqual([]);
    expect(waitOutcomes(wait({}, "completed", "{not json"))).toEqual([]);
    expect(waitOutcomes(wait({}, "completed"))).toEqual([]);
  });
});

describe("openWaitOf", () => {
  const open = wait({ agentId: "a" }, "running");

  it("is the turn's open wait when nothing after it speaks or runs", () => {
    expect(openWaitOf([prose("on it"), open])).toBe(open);
    expect(openWaitOf([open, bash("completed")])).toBe(open);
    expect(openWaitOf([open, thought("  ")])).toBe(open);
  });

  it("is nothing once prose, a thought or another running call comes after it", () => {
    expect(openWaitOf([open, prose("meanwhile")])).toBeNull();
    expect(openWaitOf([open, thought("considering")])).toBeNull();
    expect(openWaitOf([open, bash("running")])).toBeNull();
    expect(openWaitOf([wait({ agentId: "a" }, "completed", '{"agentId":"a","status":"idle"}')])).toBeNull();
    expect(openWaitOf([])).toBeNull();
  });
});
