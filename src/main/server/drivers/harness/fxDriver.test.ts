import { beforeEach, describe, expect, it } from "vitest";
import { mockChild } from "./fxChildMock";
import type { AgentEvent, SessionMeta } from "@shared/events";
import type { DriverCtx } from "../types";

const sent: string[] = [];
const killed: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;

mockChild({
  resolveFxBinary: async () => ({ path: "/fake/fx" }),
  spawnChild: async (_id: string, _cmd: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async (id: string) => {
    killed.push(id);
  },
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
});

const { fxDriver } = await import("../fx");

const parse = () => sent.map((s) => JSON.parse(s));
const reply = (id: number, result: unknown) =>
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
const notify = (update: unknown) =>
  onLine!(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "S1", update },
    }),
  );
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const method = (name: string) => parse().find((m) => m.method === name);
const of = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

function ctxFor(id: string) {
  const events: AgentEvent[] = [];
  const nativeIds: string[] = [];
  const session = {
    id,
    cwd: "/repo",
    model: "zai/glm-5.2",
    nativeId: null,
  } as unknown as SessionMeta;
  const ctx: DriverCtx = {
    session,
    emit: (e) => events.push(e),
    setNativeId: (n) => nativeIds.push(n),
    requestApproval: async () => true,
  };
  return { ctx, events, nativeIds };
}

/** Answer initialize → session/new → set_mode so the prompt goes out. */
async function boot() {
  await waitFor(() => !!method("initialize"), "initialize");
  reply(method("initialize")!.id, { protocolVersion: 1 });
  await waitFor(() => !!method("session/new"), "session/new");
  reply(method("session/new")!.id, {
    sessionId: "S1",
    configOptions: [{ id: "model", category: "model", currentValue: "zai/glm-5.2" }],
  });
  await waitFor(() => !!method("session/set_mode"), "set_mode");
  reply(method("session/set_mode")!.id, {});
  await waitFor(() => !!method("session/prompt"), "prompt");
  return method("session/prompt")!;
}

describe("fx driver", () => {
  beforeEach(() => {
    sent.length = 0;
    killed.length = 0;
    spawned.length = 0;
  });

  it("send runs a turn: tool-call with mined input, tool-result, turn-complete; dispose kills", async () => {
    const { ctx, events, nativeIds } = ctxFor("d1");
    const handle = await fxDriver.start(ctx);
    await handle.send("run it", [
      { path: "/tmp/shot.png", name: "shot.png", kind: "image" },
    ]);
    const prompt = await boot();

    expect(spawned[0]).toEqual(["acp", "--model", "zai/glm-5.2"]);
    expect(nativeIds).toEqual(["S1"]);
    expect(prompt.params.prompt).toEqual([
      { type: "text", text: "run it\n\nAttached file: /tmp/shot.png" },
    ]);
    expect(events[0]).toEqual({ type: "status", status: "running" });

    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Sure." } });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_a",
      title: "Running",
      kind: "execute",
      status: "in_progress",
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_a",
      kind: "execute",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "exit_code=0\n<stdout>\nhi\n</stdout>\n" },
        },
      ],
      command_result: { kind: "foreground", command: "echo hi", cwd: "/repo", exit_code: 0 },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_b",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "<path>notes.txt</path>\n<content>\n1\thello\n</content>" },
        },
      ],
    });
    reply(prompt.id, { stopReason: "end_turn" });
    await waitFor(() => events.some((e) => e.type === "turn-complete"), "turn-complete");

    const calls = of(events, "tool-call");
    expect(calls.find((c) => c.callId === "call_a" && (c.input as { command?: string }).command))
      .toMatchObject({ name: "Bash", input: { command: "echo hi" } });
    expect(calls.find((c) => c.callId === "call_b")).toMatchObject({
      name: "Read",
      input: { path: "notes.txt" },
      preview: { kind: "read", path: "notes.txt" },
    });
    expect(of(events, "tool-result").map((r) => [r.callId, r.output, r.isError])).toEqual([
      ["call_a", "hi", false],
      ["call_b", "1\thello", false],
    ]);
    expect(of(events, "assistant-text").at(-1)).toMatchObject({ text: "Sure.", delta: false });
    expect(events.at(-2)).toEqual({ type: "turn-complete" });
    expect(events.at(-1)).toEqual({ type: "status", status: "idle" });
    expect(of(events, "approval-request")).toHaveLength(0);

    expect(handle.approve!("nope", true)).toBe(false);
    await handle.dispose();
    expect(killed).toEqual(["d1"]);
  });

  it("interrupt cancels the ACP turn and settles it", async () => {
    const { ctx, events } = ctxFor("d2");
    const handle = await fxDriver.start(ctx);
    await handle.send("go");
    await boot();
    await expect(handle.send("again")).rejects.toThrow("still running");

    handle.interrupt();
    await waitFor(() => !!method("session/cancel"), "session/cancel");
    await waitFor(() => events.some((e) => e.type === "turn-complete"), "turn-complete");
    expect(of(events, "error")).toHaveLength(0);
    await handle.dispose();
    expect(killed).toEqual(["d2"]);
  });

  it("reports a startup failure as an error event and still settles", async () => {
    const { ctx, events } = ctxFor("d3");
    const handle = await fxDriver.start(ctx);
    await handle.send("hello");
    await waitFor(() => !!method("initialize"), "initialize");
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: method("initialize")!.id,
        error: { code: -32000, message: "Fx needs access to the AI Gateway" },
      }),
    );
    await waitFor(() => events.some((e) => e.type === "turn-complete"), "turn-complete");
    expect(of(events, "error")[0]!.message).toMatch(/AI Gateway/);
    expect(killed).toEqual(["d3"]);
    await handle.dispose();
  });
});
