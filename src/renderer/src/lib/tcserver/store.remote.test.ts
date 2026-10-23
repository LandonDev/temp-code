import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore, type Link } from "./store";
import { ConnectionLostError } from "../connection";
import { newSession } from "../session";
import type { EventRow, ServerPush, SessionMeta } from "./types";
import type { EventsPage, OmittedBody, SessionPage } from "@server/shared/wire";

/**
 * The store over a remote socket: pages of the list, bounded pages of the
 * log with history on demand, a resume that resets, coalesced pushes, and
 * bodies that stayed on the server until a row opens.
 */

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude · implementer",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function wireMeta(over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  const { environmentId: _environmentId, ...wire } = meta(over);
  return wire;
}

const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({
  sessionId,
  seq,
  ts: 1_000 + seq,
  event,
});

const omitted = (text: string): OmittedBody => ({
  omitted: true,
  bytes: text.length,
  lines: text.split("\n").length,
  head: text.split("\n")[0],
});

class RemoteLink implements Link {
  environmentId = "local";
  connected = true;
  readonly profile = "remote" as const;
  calls: { method: string; params: unknown }[] = [];
  /** session.list answers these pages in order, with a cursor between. */
  pages: Omit<SessionMeta, "environmentId">[][] = [];
  /** The log per session, as the remote socket would project it. */
  events = new Map<string, EventRow[]>();
  /** Rows whole, by `sessionId:seq`, for session.rowBody. */
  full = new Map<string, EventRow>();
  /** When set, a resume (afterSeq alone) answers this page. */
  resume: EventsPage | null = null;
  /** Rows per tail or older page. */
  pageRows = 4;
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();

  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") {
      const p = (params ?? {}) as { cursor?: string; archived?: boolean };
      if (p.archived) return Promise.resolve({ sessions: [], cursor: null } as T);
      const idx = p.cursor ? Number(p.cursor) : 0;
      const page: SessionPage = {
        sessions: this.pages[idx] ?? [],
        cursor: idx + 1 < this.pages.length ? String(idx + 1) : null,
      };
      return Promise.resolve(page as T);
    }
    if (method === "session.events") {
      const { sessionId, afterSeq = 0, beforeSeq, tail, subscribe } = params as {
        sessionId: string;
        afterSeq?: number;
        beforeSeq?: number;
        tail?: number;
        subscribe?: boolean;
      };
      // A current host subscribes inside the request and says so.
      const said = subscribe ? { subscribed: true } : {};
      const all = this.events.get(sessionId) ?? [];
      if (tail) {
        const range = all.filter((r) => r.seq > afterSeq && (beforeSeq === undefined || r.seq < beforeSeq));
        const rows = range.slice(-this.pageRows);
        const page: EventsPage = {
          rows,
          moreBefore: rows.length > 0 && rows[0].seq > afterSeq + 1,
          moreAfter: false,
          reset: false,
          ...said,
        };
        return Promise.resolve(page as T);
      }
      if (this.resume) return Promise.resolve({ ...this.resume, ...said } as T);
      // A resume without a tail answers the oldest rows after the cursor,
      // capped at a page, and says when more follow (the wire's pager caps
      // the oldest page this way; from a cursor it answers whole or resets).
      const range = all.filter((r) => r.seq > afterSeq);
      const rows = range.slice(0, this.pageRows);
      return Promise.resolve({ rows, moreBefore: false, moreAfter: rows.length < range.length, reset: false, ...said } as T);
    }
    if (method === "session.rowBody") {
      const { sessionId, seq } = params as { sessionId: string; seq: number };
      const whole = this.full.get(`${sessionId}:${seq}`);
      return whole ? Promise.resolve({ row: whole } as T) : Promise.reject(new Error("no row"));
    }
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void): () => void {
    this.pushListeners.add(l);
    return () => this.pushListeners.delete(l);
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  onClose() {
    return () => {};
  }
  push(p: ServerPush): void {
    for (const l of this.pushListeners) l(p);
  }
  open(): void {
    for (const l of this.openListeners) l();
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** Six turns of prompt + answer: seqs 1..12. */
function turns(sessionId: string, n = 6, from = 1): EventRow[] {
  const out: EventRow[] = [];
  let seq = from;
  for (let t = 1; t <= n; t++) {
    out.push(row(sessionId, seq++, { type: "user-text", text: `prompt ${t}` }));
    out.push(row(sessionId, seq++, { type: "assistant-text", text: `answer ${t}`, delta: false }));
  }
  return out;
}

let link: RemoteLink;
beforeEach(() => {
  sessionStore.reset();
  link = new RemoteLink();
});
afterEach(() => sessionStore.reset());

/** A link that reports connected lists on connect; `open()` would list again. */
async function boot(l: RemoteLink): Promise<void> {
  sessionStore.attach(l);
  await sessionStore.ready();
}

describe("remote profile: the list", () => {
  it("walks the pages and merges every one", async () => {
    link.pages = [[wireMeta({ id: "a", status: "running" })], [wireMeta({ id: "b" })], [wireMeta({ id: "c" })]];
    await boot(link);
    expect(sessionStore.metas().map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    const lists = link.calls.filter((c) => c.method === "session.list" && !(c.params as { archived?: boolean })?.archived);
    expect(lists.map((c) => (c.params as { cursor?: string })?.cursor)).toEqual([undefined, "1", "2"]);
  });
});

describe("remote profile: pushes", () => {
  it("folds a coalesced events frame and merges a sessions frame", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 1));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks).toHaveLength(2);
    link.push({
      push: "events",
      sessionId: "s1",
      rows: [
        row("s1", 3, { type: "user-text", text: "prompt 2" }),
        row("s1", 4, { type: "assistant-text", text: "answer 2", delta: false }),
      ],
    });
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual([
      "prompt 1",
      "answer 1",
      "prompt 2",
      "answer 2",
    ]);
    link.push({ push: "sessions", sessions: [wireMeta({ id: "s1", status: "running" }), wireMeta({ id: "s2" })] });
    expect(sessionStore.metaOf("s1")?.status).toBe("running");
    expect(sessionStore.metaOf("s2")).not.toBeNull();
  });
});

describe("remote profile: history", () => {
  it("paints the tail, pages older rows in on demand, and keeps the tail's block ids", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const tail = sessionStore.get("s1")!;
    expect(tail.blocks.map((b) => b.text)).toEqual(["prompt 5", "answer 5", "prompt 6", "answer 6"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
    // No eager head fetch: one session.events so far.
    expect(link.count("session.events")).toBe(1);
    const tailIds = tail.blocks.map((b) => b.id);

    expect(await sessionStore.loadOlder("s1")).toBe(true);
    const after = sessionStore.get("s1")!;
    expect(after.blocks.map((b) => b.text)).toEqual([
      "prompt 3",
      "answer 3",
      "prompt 4",
      "answer 4",
      "prompt 5",
      "answer 5",
      "prompt 6",
      "answer 6",
    ]);
    expect(after.blocks.slice(4).map((b) => b.id)).toEqual(tailIds);
    const older = link.calls.filter((c) => c.method === "session.events").at(-1)!.params as { beforeSeq?: number; tail?: number };
    expect(older.beforeSeq).toBe(9);
    expect(older.tail).toBeGreaterThan(0);

    expect(await sessionStore.loadOlder("s1")).toBe(false);
    expect(sessionStore.get("s1")?.blocks).toHaveLength(12);
    expect(sessionStore.hasOlderHistory("s1")).toBe(false);
    expect(sessionStore.isComplete("s1")).toBe(true);
  });

  it("ensureComplete pages the whole history in", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureComplete("s1");
    expect(sessionStore.get("s1")?.blocks).toHaveLength(12);
    expect(link.count("session.events")).toBe(3);
  });

  it("a push that lands while an older page folds is kept", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const loading = sessionStore.loadOlder("s1");
    link.push({ push: "event", row: row("s1", 13, { type: "user-text", text: "prompt 7" }) });
    await loading;
    const texts = sessionStore.get("s1")!.blocks.map((b) => b.text);
    expect(texts[0]).toBe("prompt 3");
    expect(texts.at(-1)).toBe("prompt 7");
  });

  it("a resume whose gap outgrew the budget takes the fresh tail and drops the old fold", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks[0].text).toBe("prompt 5");
    link.resume = {
      rows: turns("s1", 2, 41),
      moreBefore: true,
      moreAfter: false,
      reset: true,
    };
    await sessionStore.resync(link);
    const texts = sessionStore.get("s1")!.blocks.map((b) => b.text);
    expect(texts).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2"]);
    expect(sessionStore.get("s1")!.blocks[0].id).toBe("u:41");
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
  });

  it("a pane restored from the saved layout paints the tail once its host lists it, never the oldest page", async () => {
    // The stub enters as a loaded draft with no rows (the setSessions shim),
    // before the box has connected; its first list adopts it and resyncs.
    link.environmentId = "box";
    const stub = { ...newSession("box", "claude", "/repo"), id: "s1", title: "Master" };
    sessionStore.mutate((prev) => [...prev, stub]);
    link.pages = [[wireMeta({ id: "s1", title: "Master" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    const events = link.calls.filter((c) => c.method === "session.events");
    expect(events).toHaveLength(1);
    expect(events[0].params).toMatchObject({ sessionId: "s1", afterSeq: 0, tail: expect.any(Number) });
    const session = sessionStore.get("s1")!;
    expect(session.environmentId).toBe("box");
    expect(session.blocks.map((b) => b.text)).toEqual(["prompt 5", "answer 5", "prompt 6", "answer 6"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
    expect(await sessionStore.loadOlder("s1")).toBe(true);
    expect(sessionStore.get("s1")!.blocks[0].text).toBe("prompt 3");
  });

  it("a resume page that says more rows follow is followed to the end, not left as the whole fold", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks.at(-1)?.text).toBe("answer 6");
    // Six more turns landed while the socket was down: the pager answers
    // the gap four rows at a time, each page naming the cursor it left.
    link.events.set("s1", turns("s1", 12));
    const before = link.count("session.events");
    await sessionStore.resync(link);
    const pages = link.calls
      .filter((c) => c.method === "session.events")
      .slice(before)
      .map((c) => c.params as { afterSeq: number; tail?: number });
    expect(pages).toEqual([{ sessionId: "s1", afterSeq: 12 }, { sessionId: "s1", afterSeq: 16 }, { sessionId: "s1", afterSeq: 20 }]);
    expect(sessionStore.get("s1")!.blocks.map((b) => b.text).slice(-2)).toEqual(["prompt 12", "answer 12"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
  });
});

describe("remote profile: bodies off the wire", () => {
  it("a tool row shows the first line, fetches the body when asked, and is whole after", async () => {
    const output = "first line\nsecond line\nthird line";
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, { type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      row("s1", 2, {
        type: "tool-result",
        callId: "c1",
        output: omitted(output) as unknown as string,
        isError: false,
      }),
    ]);
    link.full.set("s1:2", row("s1", 2, { type: "tool-result", callId: "c1", output, isError: false }));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(block.tool?.detail).toBe("first line");
    expect(block.tool?.omitted).toEqual({ sessionId: "s1", seqs: [2], bytes: output.length });

    await sessionStore.loadRowBodies(block);
    const whole = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(whole.id).toBe(block.id);
    expect(whole.tool?.detail).toBe(output);
    expect(whole.tool?.omitted).toBeUndefined();
    expect(link.count("session.rowBody")).toBe(1);
    // Asking again costs nothing: the block is whole.
    await sessionStore.loadRowBodies(whole);
    expect(link.count("session.rowBody")).toBe(1);
  });

  it("an edit whose strings left the wire keeps its counts and comes back whole", async () => {
    const oldText = "a\nb\nc";
    const newText = "x\ny\nz\nw";
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, {
        type: "tool-call",
        callId: "e1",
        name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: omitted(oldText), new_string: omitted(newText) },
        preview: { kind: "write", path: "/repo/a.ts", fileName: "a.ts", additions: 4, deletions: 3 },
      }),
      row("s1", 2, { type: "tool-result", callId: "e1", output: "ok", isError: false }),
    ]);
    link.full.set(
      "s1:1",
      row("s1", 1, {
        type: "tool-call",
        callId: "e1",
        name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: oldText, new_string: newText },
        preview: { kind: "write", path: "/repo/a.ts", fileName: "a.ts", additions: 4, deletions: 3 },
      }),
    );
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "e1")!;
    expect(block.tool?.omitted?.seqs).toEqual([1]);
    expect(block.tool?.preview?.additions).toBe(4);
    expect(block.tool?.preview?.deletions).toBe(3);
    expect(block.tool?.status).toBe("completed");

    await sessionStore.loadRowBodies(block);
    const whole = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "e1")!;
    expect((whole.tool?.input as { old_string: string }).old_string).toBe(oldText);
    expect(whole.tool?.omitted).toBeUndefined();
    expect(whole.tool?.status).toBe("completed");
  });

  it("a body the server cannot give back marks the block failed, not loading", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, { type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      row("s1", 2, { type: "tool-result", callId: "c1", output: omitted("gone\nx") as unknown as string, isError: false }),
    ]);
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    await sessionStore.loadRowBodies(block);
    const after = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(after.tool?.omitted).toMatchObject({ seqs: [2], loading: false, failed: true });
  });
});

describe("remote profile: the load phase", () => {
  afterEach(() => vi.useRealTimers());

  it("a socket that is down keeps the thread loading (slow after 8 s) and the load starts when it opens", async () => {
    vi.useFakeTimers();
    link.pages = [[wireMeta()]];
    link.events.set("s1", turns("s1", 2));
    await boot(link);
    link.connected = false;
    const since = Date.now();
    await expect(sessionStore.ensureLoaded("s1", "pane")).rejects.toThrow("not connected");
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loading", since, attempt: 0 });
    expect(link.count("session.events")).toBe(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sessionStore.get("s1")?.load?.phase).toBe("slow");
    link.connected = true;
    link.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loaded", since, attempt: 0 });
    expect(sessionStore.get("s1")?.blocks.length).toBeGreaterThan(0);
  });

  it("a socket that comes back cuts a failed load's wait short without resetting its count", async () => {
    vi.useFakeTimers();
    link.pages = [[wireMeta()]];
    link.events.set("s1", turns("s1", 2));
    await boot(link);
    const request = link.request.bind(link);
    let failures = 3;
    link.request = <T,>(method: string, params?: unknown): Promise<T> =>
      method === "session.events" && failures-- > 0 ? Promise.reject(new ConnectionLostError("connection closed")) : request<T>(method, params);
    await sessionStore.ensureLoaded("s1").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 2, retryAt: Date.now() + 2_000 });
    link.connected = false;
    await vi.advanceTimersByTimeAsync(2_000);
    // The retry found the socket down: still failed, the count goes on.
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 3, error: "not connected", retryAt: Date.now() + 4_000 });
    link.connected = true;
    link.open();
    await vi.advanceTimersByTimeAsync(0);
    // The third failure is used up by the open's attempt; the fourth try loads.
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 4, retryAt: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sessionStore.get("s1")?.load?.phase).toBe("loaded");
  });
});
