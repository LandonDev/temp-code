import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../session";
import {
  clearGoal,
  context,
  continueAllErrors,
  continueSession,
  pauseAllRunning,
  runSettingsFor,
  setGoal,
  setThreadRules,
  queueAdd,
  queueList,
  queueRemove,
  queueReorder,
  queueSteer,
  queueUpdate,
  readFile,
  reasoningOf,
  resumeAllPaused,
  retype,
  send,
  startThread,
  steer,
  toServerAttachments,
} from "./commands";
import { sessionStore, type Link } from "./store";
import type { ServerPush, SessionMeta } from "./types";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "x", parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
    provider: "claude", model: "claude-sonnet-5", reasoning: "medium", agentType: "implementer",
    title: "t", cwd: "/repo", status: "idle", archived: false, pinned: false, permission: "edits",
    fast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: 1, updatedAt: 1, ...over,
  };
}

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: any }[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") return Promise.resolve([] as T);
    if (method === "session.create") {
      const p = params as any;
      return Promise.resolve(meta({ id: p.id ?? "minted", provider: p.provider, model: p.model, reasoning: p.reasoning ?? "medium", permission: p.permission, cwd: p.cwd ?? "/repo", status: "running", threadType: p.threadType ?? null, planPath: p.planPath ?? null, agentType: p.agentType ?? "implementer" }) as T);
    }
    if (method === "session.send") {
      const p = params as any;
      // The server echoes the message, works, and settles a tick later.
      setTimeout(() => {
        this.push({ push: "event", row: { sessionId: p.sessionId, seq: 1, ts: 1, event: { type: "user-text", text: p.text } } });
        this.push({ push: "session", session: meta({ id: p.sessionId, status: "running" }) });
        this.push({ push: "session", session: meta({ id: p.sessionId, status: "idle" }) });
      }, 0);
      return Promise.resolve(null as T);
    }
    if (method === "file.read") return (params as any).path === "/repo/.temp-code/plan.md" ? Promise.resolve("# Plan" as T) : Promise.reject(new Error("outside"));
    if (method === "queue.add") return Promise.resolve({ id: "m1", text: (params as any).text, ts: 1 } as T);
    if (method === "queue.list") return Promise.resolve([{ id: "q1", text: "one", ts: 1 }, { id: "q2", text: "two", ts: 2 }] as T);
    if (method === "session.resumeAllPaused" || method === "session.continueAllErrors") {
      return Promise.resolve({ attempted: ["s1"], succeeded: ["s1"], failed: [] } as T);
    }
    if (method === "attachment.save") return Promise.resolve({ path: "/saved/" + (params as any).name, name: (params as any).name, kind: "image" } as T);
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void) { this.pushListeners.add(l); return () => this.pushListeners.delete(l); }
  onOpen() { return () => {}; }
  push(p: ServerPush) { for (const l of this.pushListeners) l(p); }
  of(method: string) { return this.calls.filter((c) => c.method === method).map((c) => c.params); }
}

let link: FakeLink;
beforeEach(async () => {
  link = new FakeLink();
  sessionStore.reset();
  sessionStore.connect(link);
  await sessionStore.ready();
});
afterEach(() => sessionStore.reset());

describe("send", () => {
  it("creates a draft with its own id, then sends, then waits for idle", async () => {
    const draft = { ...newSession("claude", "/repo", "claude:sonnet-5", "supervised"), modelSettings: { effort: "high" } };
    sessionStore.mutate([draft]);
    await send(draft, "hello", [], undefined, undefined, link);
    expect(link.of("session.create")[0]).toMatchObject({ id: draft.id, provider: "claude", model: "claude-sonnet-5", reasoning: "high", cwd: "/repo", permission: "safe", context1m: false });
    expect(link.of("session.send")[0]).toEqual({ sessionId: draft.id, text: "hello" });
    expect(sessionStore.isDraft(draft.id)).toBe(false);
    expect(sessionStore.get(draft.id)!.busy).toBe(false);
    expect(sessionStore.get(draft.id)!.blocks[0]).toMatchObject({ role: "user", text: "hello" });
  });

  it("sends only what differs from the server meta", async () => {
    link.push({ push: "session", session: meta({ id: "s1", provider: "claude", model: "claude-sonnet-5", reasoning: "medium" }) });
    const session = { ...sessionStore.get("s1")!, model: "claude:opus-5", modelSettings: { effort: "max" } };
    sessionStore.mutate([session]);
    await send(session, "again", [], undefined, undefined, link);
    expect(link.of("session.create")).toHaveLength(0);
    expect(link.of("session.send")[0]).toEqual({ sessionId: "s1", text: "again", model: "claude-opus-5", reasoning: "max" });
  });

  it("a harness switch rides as provider", async () => {
    link.push({ push: "session", session: meta({ id: "s1" }) });
    const session = { ...sessionStore.get("s1")!, harness: "codex" as const, model: "codex:gpt-5.5", modelSettings: {} };
    sessionStore.mutate([session]);
    await send(session, "switch", [], undefined, undefined, link);
    expect(link.of("session.send")[0]).toMatchObject({ provider: "codex", model: "gpt-5.5" });
  });

  it("~ cwd is left to the server and fast is tuned after create", async () => {
    const draft = { ...newSession("claude", "~"), modelSettings: { fast: "true", context: "1m" } };
    sessionStore.mutate([draft]);
    await send(draft, "x", [], undefined, undefined, link);
    expect(link.of("session.create")[0].cwd).toBeUndefined();
    expect(link.of("session.create")[0].context1m).toBe(true);
    expect(link.of("session.tune")[0]).toEqual({ sessionId: draft.id, fast: true });
  });
});

describe("thread commands", () => {
  it("create carries the thread type and its agent type", async () => {
    const draft = newSession("claude", "/repo", undefined, undefined, undefined, { threadType: "orchestration" });
    sessionStore.mutate([draft]);
    await send(draft, "go", [], undefined, undefined, link);
    expect(link.of("session.create")[0]).toMatchObject({ threadType: "orchestration", agentType: "orchestrator" });
    const chat = newSession("claude", "/repo");
    sessionStore.mutate([chat]);
    await send(chat, "hi", [], undefined, undefined, link);
    expect(link.of("session.create")[1]).toMatchObject({ threadType: "chat", agentType: "implementer" });
  });

  it("a new pass rides the send and opens a round", async () => {
    link.push({ push: "session", session: meta({ id: "s1" }) });
    const session = sessionStore.get("s1")!;
    sessionStore.mutate([session]);
    await send(session, "first", [], undefined, undefined, link);
    await send(sessionStore.get("s1")!, "pass two", [], { newPass: true }, undefined, link);
    expect(link.of("session.send")[1]).toMatchObject({ text: "pass two", newPass: true });
    expect(sessionStore.get("s1")!.thread?.round).toBe(1);
  });

  it("retype patches a draft locally and asks the server for a created thread", async () => {
    const draft = newSession("claude", "/repo");
    sessionStore.mutate([draft]);
    await retype(draft.id, "planning", link);
    expect(sessionStore.get(draft.id)!.threadType).toBe("planning");
    expect(link.of("session.retype")).toHaveLength(0);
    link.push({ push: "session", session: meta({ id: "s1", threadType: "chat" }) });
    await retype("s1", "research", link);
    expect(link.of("session.retype")[0]).toEqual({ sessionId: "s1", threadType: "research" });
  });

  it("readFile returns null for anything the server refuses", async () => {
    expect(await readFile("/repo/.temp-code/plan.md", link)).toBe("# Plan");
    expect(await readFile("/etc/passwd", link)).toBeNull();
  });

  it("startThread creates, adopts, sends the brief, and announces the session once", async () => {
    const added: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    const meta = await startThread(
      { threadType: "implementation", provider: "claude", model: "claude-sonnet-5", planPath: "/repo/.temp-code/plan.md", title: "Build it", projectId: "p1" },
      "Implement the plan.",
      link,
    );
    expect(link.of("session.create")[0]).toMatchObject({ threadType: "implementation", agentType: "implementer", planPath: "/repo/.temp-code/plan.md", title: "Build it" });
    expect(link.of("session.send")[0]).toMatchObject({ sessionId: meta.id, text: "Implement the plan." });
    link.push({ push: "session", session: { ...meta, status: "running" } });
    expect(added).toEqual([meta.id]);
    expect(sessionStore.isDraft(meta.id)).toBe(false);
  });
});

describe("steer", () => {
  it("queues then steers", async () => {
    link.push({ push: "session", session: meta({ id: "s1", status: "running" }) });
    const session = sessionStore.get("s1")!;
    sessionStore.mutate([session]);
    await steer(session, "also", [], undefined, undefined, link);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "also" });
    expect(link.of("queue.steer")[0]).toEqual({ sessionId: "s1", messageId: "m1" });
    expect(sessionStore.get("s1")!.blocks.at(-1)).toMatchObject({ role: "user", text: "also", pending: true });
  });
});

describe("queue", () => {
  beforeEach(() => {
    link.push({ push: "session", session: meta({ id: "s1", status: "running" }) });
  });

  it("lists into the store; a draft has nothing to list", async () => {
    expect(await queueList("s1", link)).toHaveLength(2);
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q1", "q2"]);
    expect(await queueList("draft", link)).toEqual([]);
    expect(link.of("queue.list")).toEqual([{ sessionId: "s1" }]);
  });

  it("add, update, remove and steer are one RPC each", async () => {
    await queueAdd("s1", "later", [{ path: "/a", name: "a", kind: "file" }], {}, link);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "later", attachments: [{ path: "/a", name: "a", kind: "file" }] });
    await queueUpdate("s1", "q1", "edited", link);
    expect(link.of("queue.update")[0]).toEqual({ sessionId: "s1", messageId: "q1", text: "edited" });
    await queueRemove("s1", "q1", link);
    expect(link.of("queue.remove")[0]).toEqual({ sessionId: "s1", messageId: "q1" });
    await queueSteer("s1", "q2", link);
    expect(link.of("queue.steer")[0]).toEqual({ sessionId: "s1", messageId: "q2" });
  });

  it("reorder is optimistic and the push wins", async () => {
    await queueList("s1", link);
    const pending = queueReorder("s1", ["q2", "q1"], link);
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q2", "q1"]);
    await pending;
    expect(link.of("queue.reorder")[0]).toEqual({ sessionId: "s1", order: ["q2", "q1"] });
    link.push({ push: "queue", sessionId: "s1", items: [{ id: "q1", text: "one", ts: 1 }] });
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q1"]);
  });

  it("batch recovery returns the server tally; continue skips drafts", async () => {
    expect(await resumeAllPaused(link)).toMatchObject({ succeeded: ["s1"] });
    expect(await continueAllErrors(link)).toMatchObject({ succeeded: ["s1"] });
    await continueSession("s1", {}, link);
    await continueSession("s1", { model: "claude-opus-5-5", reasoning: "high" }, link);
    await continueSession("draft", {}, link);
    expect(link.of("session.continue")).toEqual([
      { sessionId: "s1" },
      { sessionId: "s1", model: "claude-opus-5-5", reasoning: "high" },
    ]);
  });
});

describe("attachments and reasoning", () => {
  it("paths pass through, pasted bytes are saved first", async () => {
    const files = await toServerAttachments(
      [
        { id: "1", name: "a.ts", mimeType: "text/plain", kind: "file", size: 1, path: "/repo/a.ts" },
        { id: "2", name: "shot.png", mimeType: "image/png", kind: "image", size: 1, data: "AAAA" },
      ],
      link,
    );
    expect(files).toEqual([
      { path: "/repo/a.ts", name: "a.ts", kind: "file", mime: "text/plain" },
      { path: "/saved/shot.png", name: "shot.png", kind: "image" },
    ]);
    expect(link.of("attachment.save")[0]).toEqual({ name: "shot.png", dataBase64: "AAAA" });
  });

  it("clamps efforts the server does not know", () => {
    expect(reasoningOf({ modelSettings: { effort: "ultrathink" } })).toBe("max");
    expect(reasoningOf({ modelSettings: { effort: "xhigh" } })).toBe("xhigh");
    expect(reasoningOf({ modelSettings: {} })).toBeUndefined();
  });
});

describe("run settings on queued messages", () => {
  beforeEach(() => {
    link.push({ push: "session", session: meta({ id: "s1", status: "running" }) });
  });

  it("carries only what the local session changed", () => {
    const session = sessionStore.get("s1")!;
    expect(runSettingsFor(session)).toEqual({});
    expect(runSettingsFor({ ...session, model: "claude:opus-5", modelSettings: { effort: "high" } })).toEqual({ model: "claude-opus-5", reasoning: "high" });
    expect(runSettingsFor({ ...session, harness: "codex", model: "codex:gpt-6-astra" })).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
  });

  it("a steered message rides with the picker's model", async () => {
    const session = { ...sessionStore.get("s1")!, model: "claude:opus-5" };
    sessionStore.mutate([session]);
    await steer(session, "switch", [], undefined, undefined, link);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "switch", model: "claude-opus-5" });
  });

  it("queueAdd spreads the settings it is given", async () => {
    await queueAdd("s1", "later", [], { provider: "codex", model: "gpt-6-astra", reasoning: "high" }, link);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "later", provider: "codex", model: "gpt-6-astra", reasoning: "high" });
  });
});

describe("session wrappers", () => {
  it("map one to one onto the server methods and skip drafts", async () => {
    link.push({ push: "session", session: meta({ id: "s1" }) });
    await pauseAllRunning(link);
    expect(link.of("session.pauseAllRunning")).toEqual([undefined]);
    expect(await context("draft", link)).toBeNull();
    await context("s1", link);
    expect(link.of("session.context")).toEqual([{ sessionId: "s1" }]);
    await setGoal("s1", "tests pass", link);
    await clearGoal("s1", link);
    await setThreadRules("s1", null, link);
    expect(link.of("session.setGoal")).toEqual([{ sessionId: "s1", condition: "tests pass" }]);
    expect(link.of("session.clearGoal")).toEqual([{ sessionId: "s1" }]);
    expect(link.of("session.setThreadRules")).toEqual([{ sessionId: "s1", threadRules: null }]);
  });
});
