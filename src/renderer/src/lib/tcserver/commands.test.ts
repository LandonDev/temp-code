import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../connection";
import { newSession } from "../session";
import {
  clearGoal,
  context,
  continueAllErrors,
  continueSession,
  FocusSignal,
  pauseAllRunning,
  sessionBatch,
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
    environmentId: "local",
    id: "x", parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
    provider: "claude", model: "claude-sonnet-5-5", reasoning: "medium", agentType: "implementer",
    title: "t", cwd: "/repo", status: "idle", archived: false, pinned: false, permission: "edits",
    fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: 1, updatedAt: 1, ...over,
  };
}

function wireMeta(over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  const { environmentId: _environmentId, ...wire } = meta(over);
  return wire;
}

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  /** How queue.add answers: an older host's bare item, the typed queued answer, or a steer. */
  queueAnswer: "item" | "queued" | "steered" = "item";
  calls: { method: string; params: any }[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") return Promise.resolve([] as T);
    if (method === "session.create") {
      const p = params as any;
      return Promise.resolve(wireMeta({ id: p.id ?? "minted", provider: p.provider, model: p.model, reasoning: p.reasoning ?? "medium", permission: p.permission, cwd: p.cwd ?? "/repo", status: "running", threadType: p.threadType ?? null, planPath: p.planPath ?? null, agentType: p.agentType ?? "implementer" }) as T);
    }
    if (method === "session.send") {
      const p = params as any;
      // The server echoes the message, works, and settles a tick later.
      setTimeout(() => {
        this.push({ push: "event", row: { sessionId: p.sessionId, seq: 1, ts: 1, event: { type: "user-text", text: p.text } } });
        this.push({ push: "session", session: wireMeta({ id: p.sessionId, status: "running" }) });
        this.push({ push: "session", session: wireMeta({ id: p.sessionId, status: "idle" }) });
      }, 0);
      return Promise.resolve(null as T);
    }
    if (method === "file.read") return (params as any).path === "/repo/.temp-code/plan.md" ? Promise.resolve("# Plan" as T) : Promise.reject(new Error("outside"));
    if (method === "queue.add") {
      const item = { id: "m1", text: (params as any).text, ts: 1 };
      if (this.queueAnswer === "item") return Promise.resolve(item as T);
      return Promise.resolve((this.queueAnswer === "steered" ? { kind: "steered", id: "m1" } : { kind: "queued", item }) as T);
    }
    if (method === "queue.list") return Promise.resolve([{ id: "q1", text: "one", ts: 1 }, { id: "q2", text: "two", ts: 2 }] as T);
    if (method === "session.batch") {
      const p = params as any;
      return Promise.resolve({ attempted: p.ids, succeeded: p.ids.slice(1), failed: p.ids.slice(0, 1).map((sessionId: string) => ({ sessionId, error: "harness not responding" })) } as T);
    }
    if (method === "session.resumeAllPaused" || method === "session.continueAllErrors") {
      return Promise.resolve({ attempted: ["s1"], succeeded: ["s1"], failed: [] } as T);
    }
    if (method === "attachment.save") return Promise.resolve({ path: "/saved/" + (params as any).name, name: (params as any).name, kind: "image" } as T);
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void) { this.pushListeners.add(l); return () => this.pushListeners.delete(l); }
  onOpen() { return () => {}; }
  onClose() { return () => {}; }
  push(p: ServerPush) { for (const l of this.pushListeners) l(p); }
  of(method: string) { return this.calls.filter((c) => c.method === method).map((c) => c.params); }
}

let link: FakeLink;
beforeEach(async () => {
  link = new FakeLink();
  vi.spyOn(registry, "linkOf").mockImplementation((environmentId) => {
    expect(environmentId).toBe("local");
    return link as unknown as ReturnType<typeof registry.linkOf>;
  });
  sessionStore.reset();
  sessionStore.attach(link);
  await sessionStore.ready();
});
afterEach(() => {
  sessionStore.reset();
  vi.restoreAllMocks();
});

describe("send", () => {
  it("creates a draft with its own id, then sends, then waits for idle", async () => {
    const draft = { ...newSession("local", "claude", "/repo", "claude:sonnet-5.5", "supervised"), modelSettings: { effort: "high" } };
    sessionStore.mutate([draft]);
    await send(draft, "hello", [], undefined, undefined);
    expect(link.of("session.create")[0]).toMatchObject({ id: draft.id, provider: "claude", model: "claude-sonnet-5-5", reasoning: "high", cwd: "/repo", permission: "safe", context1m: false });
    expect(link.of("session.send")[0]).toEqual({ sessionId: draft.id, text: "hello" });
    expect(sessionStore.isDraft(draft.id)).toBe(false);
    expect(sessionStore.get(draft.id)!.busy).toBe(false);
    expect(sessionStore.get(draft.id)!.blocks[0]).toMatchObject({ role: "user", text: "hello" });
  });

  it("a provisional entry is never created: a send into it fails instead of minting a second thread", async () => {
    const shown = sessionStore.provisional("elsewhere", "local");
    await expect(send(shown, "hello", [], undefined, undefined)).rejects.toThrow("still loading");
    expect(link.of("session.create")).toHaveLength(0);
    expect(link.of("session.send")).toHaveLength(0);
  });

  it("sends only what differs from the server meta", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1", provider: "claude", model: "claude-sonnet-5-5", reasoning: "medium" }) });
    const session = { ...sessionStore.get("s1")!, model: "claude:opus-5", modelSettings: { effort: "max" } };
    sessionStore.mutate([session]);
    await send(session, "again", [], undefined, undefined);
    expect(link.of("session.create")).toHaveLength(0);
    expect(link.of("session.send")[0]).toEqual({ sessionId: "s1", text: "again", model: "claude-opus-5", reasoning: "max" });
  });

  it("a harness switch rides as provider", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1" }) });
    const session = { ...sessionStore.get("s1")!, harness: "codex" as const, model: "codex:gpt-5.5", modelSettings: {} };
    sessionStore.mutate([session]);
    await send(session, "switch", [], undefined, undefined);
    expect(link.of("session.send")[0]).toMatchObject({ provider: "codex", model: "gpt-5.5" });
  });

  it("~ cwd is left to the server and fast is tuned after create", async () => {
    const draft = { ...newSession("local", "claude", "~"), modelSettings: { fast: "true", context: "1m" } };
    sessionStore.mutate([draft]);
    await send(draft, "x", [], undefined, undefined);
    expect(link.of("session.create")[0].cwd).toBeUndefined();
    expect(link.of("session.create")[0].context1m).toBe(true);
    expect(link.of("session.tune")[0]).toEqual({ sessionId: draft.id, fast: true });
  });
});

describe("thread commands", () => {
  it("create carries the thread type and its agent type", async () => {
    const draft = newSession("local", "claude", "/repo", undefined, undefined, undefined, { threadType: "orchestration" });
    sessionStore.mutate([draft]);
    await send(draft, "go", [], undefined, undefined);
    expect(link.of("session.create")[0]).toMatchObject({ threadType: "orchestration", agentType: "orchestrator" });
    const chat = newSession("local", "claude", "/repo");
    sessionStore.mutate([chat]);
    await send(chat, "hi", [], undefined, undefined);
    expect(link.of("session.create")[1]).toMatchObject({ threadType: "chat", agentType: "implementer" });
  });

  it("a new pass rides the send and opens a round", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1" }) });
    const session = sessionStore.get("s1")!;
    sessionStore.mutate([session]);
    await send(session, "first", [], undefined, undefined);
    await send(sessionStore.get("s1")!, "pass two", [], { newPass: true }, undefined);
    expect(link.of("session.send")[1]).toMatchObject({ text: "pass two", newPass: true });
    expect(sessionStore.get("s1")!.thread?.round).toBe(1);
  });

  it("retype patches a draft locally and asks the server for a created thread", async () => {
    const draft = newSession("local", "claude", "/repo");
    sessionStore.mutate([draft]);
    await retype(draft.id, "planning");
    expect(sessionStore.get(draft.id)!.threadType).toBe("planning");
    expect(link.of("session.retype")).toHaveLength(0);
    link.push({ push: "session", session: wireMeta({ id: "s1", threadType: "chat" }) });
    await retype("s1", "research");
    expect(link.of("session.retype")[0]).toEqual({ sessionId: "s1", threadType: "research" });
  });

  it("readFile returns null for anything the server refuses", async () => {
    expect(await readFile("local", "/repo/.temp-code/plan.md")).toBe("# Plan");
    expect(await readFile("local", "/etc/passwd")).toBeNull();
  });

  it("startThread creates, adopts, sends the brief, and announces the session once", async () => {
    const added: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    const meta = await startThread(
      { environmentId: "local", threadType: "implementation", provider: "claude", model: "claude-sonnet-5-5", planPath: "/repo/.temp-code/plan.md", title: "Build it", projectId: "p1" },
      "Implement the plan.",
    );
    expect(link.of("session.create")[0]).toMatchObject({ threadType: "implementation", agentType: "implementer", planPath: "/repo/.temp-code/plan.md", title: "Build it" });
    expect(link.of("session.send")[0]).toMatchObject({ sessionId: meta.id, text: "Implement the plan." });
    link.push({ push: "session", session: wireMeta({ ...meta, status: "running" }) });
    expect(added).toEqual([meta.id]);
    expect(sessionStore.isDraft(meta.id)).toBe(false);
  });
});

describe("steer", () => {
  it("asks the host to steer; a host that queued instead gets the message sent into the turn", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1", status: "running" }) });
    const session = sessionStore.get("s1")!;
    sessionStore.mutate([session]);
    await steer(session, "also", [], undefined, undefined);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "also", steer: true });
    expect(link.of("queue.steer")[0]).toEqual({ sessionId: "s1", messageId: "m1" });
    expect(sessionStore.get("s1")!.blocks.at(-1)).toMatchObject({ role: "user", text: "also", pending: true });
  });

  it("a host that steered the message itself is not asked again", async () => {
    link.queueAnswer = "steered";
    link.push({ push: "session", session: wireMeta({ id: "s1", status: "running" }) });
    const session = sessionStore.get("s1")!;
    sessionStore.mutate([session]);
    await steer(session, "also", [], undefined, undefined);
    expect(link.of("queue.add")).toHaveLength(1);
    expect(link.of("queue.steer")).toEqual([]);
  });

  it("queueAdd reads the typed answer and never throws on a steer", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1", status: "running" }) });
    link.queueAnswer = "queued";
    expect(await queueAdd("s1", "later", [], {})).toEqual({ kind: "queued", item: { id: "m1", text: "later", ts: 1 } });
    link.queueAnswer = "steered";
    expect(await queueAdd("s1", "now", [], {}, true)).toEqual({ kind: "steered", id: "m1" });
    expect(link.of("queue.add").at(-1)).toEqual({ sessionId: "s1", text: "now", steer: true });
  });
});

describe("queue", () => {
  beforeEach(() => {
    link.push({ push: "session", session: wireMeta({ id: "s1", status: "running" }) });
  });

  it("lists into the store; a draft has nothing to list", async () => {
    expect(await queueList("s1")).toHaveLength(2);
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q1", "q2"]);
    sessionStore.mutate(() => [{ ...newSession("local", "claude", "/repo"), id: "draft" }]);
    expect(await queueList("draft")).toEqual([]);
    expect(link.of("queue.list")).toEqual([{ sessionId: "s1" }]);
  });

  it("add, update, remove and steer are one RPC each", async () => {
    await queueAdd("s1", "later", [{ path: "/a", name: "a", kind: "file" }], {});
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "later", attachments: [{ path: "/a", name: "a", kind: "file" }] });
    await queueUpdate("s1", "q1", "edited");
    expect(link.of("queue.update")[0]).toEqual({ sessionId: "s1", messageId: "q1", text: "edited" });
    await queueRemove("s1", "q1");
    expect(link.of("queue.remove")[0]).toEqual({ sessionId: "s1", messageId: "q1" });
    await queueSteer("s1", "q2");
    expect(link.of("queue.steer")[0]).toEqual({ sessionId: "s1", messageId: "q2" });
  });

  it("reorder is optimistic and the push wins", async () => {
    await queueList("s1");
    const pending = queueReorder("s1", ["q2", "q1"]);
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q2", "q1"]);
    await pending;
    expect(link.of("queue.reorder")[0]).toEqual({ sessionId: "s1", order: ["q2", "q1"] });
    link.push({ push: "queue", sessionId: "s1", items: [{ id: "q1", text: "one", ts: 1 }] });
    expect(sessionStore.queueOf("s1").map((m) => m.id)).toEqual(["q1"]);
  });

  it("batch recovery returns the server tally; continue skips drafts", async () => {
    expect(await resumeAllPaused("local")).toMatchObject({ succeeded: ["s1"] });
    expect(await continueAllErrors("local")).toMatchObject({ succeeded: ["s1"] });
    await continueSession("s1", {});
    await continueSession("s1", { model: "claude-opus-5-5", reasoning: "high" });
    sessionStore.mutate(() => [{ ...newSession("local", "claude", "/repo"), id: "draft" }]);
    await continueSession("draft", {});
    expect(link.of("session.continue")).toEqual([
      { sessionId: "s1" },
      { sessionId: "s1", model: "claude-opus-5-5", reasoning: "high" },
    ]);
  });
});

describe("attachments and reasoning", () => {
  it("paths pass through, pasted bytes are saved first", async () => {
    const files = await toServerAttachments(
      "local",
      [
        { id: "1", name: "a.ts", mimeType: "text/plain", kind: "file", size: 1, path: "/repo/a.ts" },
        { id: "2", name: "shot.png", mimeType: "image/png", kind: "image", size: 1, data: "AAAA" },
      ],
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
    link.push({ push: "session", session: wireMeta({ id: "s1", status: "running" }) });
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
    await steer(session, "switch", [], undefined, undefined);
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "switch", model: "claude-opus-5", steer: true });
  });

  it("queueAdd spreads the settings it is given", async () => {
    await queueAdd("s1", "later", [], { provider: "codex", model: "gpt-6-astra", reasoning: "high" });
    expect(link.of("queue.add")[0]).toEqual({ sessionId: "s1", text: "later", provider: "codex", model: "gpt-6-astra", reasoning: "high" });
  });
});

describe("session wrappers", () => {
  it("map one to one onto the server methods and skip drafts", async () => {
    link.push({ push: "session", session: wireMeta({ id: "s1" }) });
    await pauseAllRunning("local");
    expect(link.of("session.pauseAllRunning")).toEqual([undefined]);
    sessionStore.mutate(() => [{ ...newSession("local", "claude", "/repo"), id: "draft" }]);
    expect(await context("draft")).toBeNull();
    await context("s1");
    expect(link.of("session.context")).toEqual([{ sessionId: "s1" }]);
    await setGoal("s1", "tests pass");
    await clearGoal("s1");
    await setThreadRules("s1", null);
    expect(link.of("session.setGoal")).toEqual([{ sessionId: "s1", condition: "tests pass" }]);
    expect(link.of("session.clearGoal")).toEqual([{ sessionId: "s1" }]);
    expect(link.of("session.setThreadRules")).toEqual([{ sessionId: "s1", threadRules: null }]);
  });

  it("session.batch carries the action, the ids and cleanup only when asked, and answers per id", async () => {
    const result = await sessionBatch("local", "pause", ["s1", "s2"]);
    expect(link.of("session.batch")).toEqual([{ action: "pause", ids: ["s1", "s2"] }]);
    expect(result).toEqual({ attempted: ["s1", "s2"], succeeded: ["s2"], failed: [{ sessionId: "s1", error: "harness not responding" }] });
    await sessionBatch("local", "archive", ["s3"], { cleanup: true });
    expect(link.of("session.batch")[1]).toEqual({ action: "archive", ids: ["s3"], cleanup: true });
  });
});

describe("FocusSignal", () => {
  class FocusLink {
    connected = true;
    sent: (string | null)[] = [];
    request<T>(method: string, params?: unknown): Promise<T> {
      expect(method).toBe("session.focus");
      this.sent.push((params as { sessionId: string | null }).sessionId);
      return Promise.resolve(null as T);
    }
  }
  const setup = () => {
    const links: Record<string, FocusLink> = { mac: new FocusLink(), box: new FocusLink() };
    const queue: (() => void)[] = [];
    const signal = new FocusSignal((env) => links[env], (fn) => queue.push(fn));
    const settle = () => {
      while (queue.length) queue.shift()!();
    };
    return { links, signal, settle };
  };

  it("sends one focus per change, folding a pane's cleanup and the next pane's effect into one", () => {
    const { links, signal, settle } = setup();
    signal.pane("mac", "a");
    settle();
    signal.left("a");
    signal.pane("mac", "b");
    settle();
    signal.pane("mac", "b");
    settle();
    expect(links.mac.sent).toEqual(["a", "b"]);
    expect(links.box.sent).toEqual([]);
  });

  it("moving to a thread on another host clears the first host's focus", () => {
    const { links, signal, settle } = setup();
    signal.pane("mac", "a");
    settle();
    signal.left("a");
    signal.pane("box", "x");
    settle();
    expect(links.mac.sent).toEqual(["a", null]);
    expect(links.box.sent).toEqual(["x"]);
  });

  it("a blurred window clears every host; focus back restores the pane's thread", () => {
    const { links, signal, settle } = setup();
    signal.pane("box", "x");
    settle();
    signal.window(false);
    settle();
    signal.window(true);
    settle();
    expect(links.box.sent).toEqual(["x", null, "x"]);
    // A stale cleanup for a thread no longer shown changes nothing.
    signal.left("gone");
    settle();
    expect(links.box.sent).toEqual(["x", null, "x"]);
  });

  it("a send that failed leaves the host unknown, so the next change still reaches it", async () => {
    const { links, signal, settle } = setup();
    let fail = true;
    const request = links.mac.request.bind(links.mac);
    links.mac.request = <T,>(method: string, params?: unknown): Promise<T> => {
      const sent = request<T>(method, params);
      return fail ? sent.then(() => Promise.reject(new Error("timed out"))) : sent;
    };
    signal.pane("mac", "a");
    settle();
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    signal.left("a");
    signal.pane("box", "x");
    settle();
    expect(links.mac.sent).toEqual(["a", null]);
    expect(links.box.sent).toEqual(["x"]);
  });

  it("a reconnect sends the focus again; a closed link is told once it opens", () => {
    const { links, signal, settle } = setup();
    links.mac.connected = false;
    signal.pane("mac", "a");
    settle();
    expect(links.mac.sent).toEqual([]);
    links.mac.connected = true;
    signal.reopened("mac");
    settle();
    signal.reopened("mac");
    settle();
    expect(links.mac.sent).toEqual(["a", "a"]);
  });
});
