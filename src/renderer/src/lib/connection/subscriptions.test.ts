import { describe, expect, it } from "vitest";
import type { ServerPush } from "@server/shared/contract";
import type { Link } from "./link";
import { Subscriptions, asPage, type SubscriptionHandlers } from "./subscriptions";
import { flush } from "./testing";

class FakeLink implements Link {
  environmentId = "env_a";
  connected = true;
  calls: { method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  /** A local socket keeps subscribe and fetch apart; a remote one asks for both at once. */
  constructor(readonly profile: "local" | "remote" = "local") {}
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.calls.push({ method, params, resolve: resolve as (v: unknown) => void, reject }),
    );
  }
  onPush(_l: (push: ServerPush) => void): () => void {
    return () => undefined;
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }
  /** A replacement session came up. */
  reopen(): void {
    this.connected = true;
    for (const l of this.openListeners) l();
  }
  drop(): void {
    this.connected = false;
    for (const l of this.closeListeners) l();
  }
  /** Answer the oldest unanswered call of `method`. */
  answer(method: string, value: unknown): void {
    const i = this.calls.findIndex((c) => c.method === method && !("done" in c));
    if (i < 0) throw new Error(`no pending ${method}`);
    const call = this.calls[i];
    Object.assign(call, { done: true });
    call.resolve(value);
  }
  refuse(method: string, message: string): void {
    const call = this.calls.find((c) => c.method === method && !("done" in c))!;
    Object.assign(call, { done: true });
    call.reject(new Error(message));
  }
  pendingOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method && !("done" in c)).map((c) => c.params);
  }
}

function owner(cursor = 0) {
  const log: string[] = [];
  const handlers: SubscriptionHandlers & { cursorValue: number } = {
    cursorValue: cursor,
    cursor: () => handlers.cursorValue,
    begin: () => log.push("begin"),
    page: (page) => {
      log.push(`page reset=${page.reset} rows=${page.rows.map((r) => r.seq).join(",")}`);
      const last = page.rows.at(-1);
      if (last) handlers.cursorValue = last.seq;
    },
    end: () => log.push("end"),
    gone: (reason) => log.push(`gone ${reason}`),
  };
  return { handlers, log };
}

const row = (seq: number) => ({ sessionId: "s1", seq, ts: seq, event: { kind: "status", status: "idle" } }) as never;

describe("asPage", () => {
  it("wraps a bare row array and reads the head off the first seq on a cold open", () => {
    expect(asPage([row(1)], true)).toEqual({ rows: [row(1)], moreBefore: false, moreAfter: false, reset: false });
    expect(asPage([row(5), row(6)], true)).toMatchObject({ moreBefore: true, reset: false });
    expect(asPage([row(5)], false)).toMatchObject({ moreBefore: false, reset: false });
    const page = { rows: [], moreBefore: true, moreAfter: false, reset: true };
    expect(asPage(page, false)).toBe(page);
  });
});

describe("Subscriptions", () => {
  it("subscribes once on a socket, then fetches what follows the owner's cursor", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(10);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }]);
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 10 }]);
    link.answer("session.events", { rows: [row(11), row(12)], moreBefore: false, moreAfter: false, reset: false });
    const page = await p;
    expect(page.rows.map((r) => r.seq)).toEqual([11, 12]);
    expect(a.log).toEqual(["begin", "page reset=false rows=11,12", "end"]);
    expect(subs.isLive("s1")).toBe(true);
    // Already subscribed on this socket: the next resume only fetches.
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 12 }]);
  });

  it("a cold open asks for the tail; a bare array answer is history behind the tail, not a reset", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 3 });
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 3 }]);
    link.answer("session.events", [row(5), row(6)]);
    const page = await p;
    expect(page.moreBefore).toBe(true);
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "end"]);
  });

  it("passes a reset page through: the owner throws its fold away before folding", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(40);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", { rows: [row(900), row(901)], moreBefore: true, moreAfter: false, reset: true });
    await p;
    expect(a.log).toEqual(["begin", "page reset=true rows=900,901", "end"]);
    expect(a.handlers.cursorValue).toBe(901);
  });

  it("a replacement session forgets what was subscribed; resumeAll subscribes everyone again, four at a time", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const owners = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id, i) => {
      const o = owner(i + 1);
      subs.add(id, o.handlers);
      return { id, ...o };
    });
    for (const o of owners) {
      void subs.resume(o.id);
      await flush();
      link.answer("session.subscribe", {});
      await flush();
      link.answer("session.events", []);
    }
    await flush();
    expect(owners.every((o) => subs.isLive(o.id))).toBe(true);
    link.drop();
    expect(subs.isLive("s1")).toBe(false);
    link.reopen();
    const all = subs.resumeAll();
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }, { sessionId: "s4" }]);
    for (let i = 0; i < 4; i++) link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events").map((p) => (p as { afterSeq: number }).afterSeq)).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < 4; i++) link.answer("session.events", []);
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s5" }, { sessionId: "s6" }]);
    link.answer("session.subscribe", {});
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", []);
    link.answer("session.events", []);
    await all;
    expect(subs.ids()).toHaveLength(6);
    expect(owners.every((o) => subs.isLive(o.id))).toBe(true);
  });

  it("remove tells a live socket, and nothing when there is none", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    subs.add("s2", a.handlers);
    void subs.resume("s1");
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", []);
    await flush();
    subs.remove("s1");
    expect(link.pendingOf("session.unsubscribe")).toEqual([{ sessionId: "s1" }]);
    subs.remove("s2");
    expect(link.pendingOf("session.unsubscribe")).toHaveLength(1);
    expect(subs.ids()).toEqual([]);
  });

  it("a refused subscribe reports the session gone and rejects the resume", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    link.refuse("session.subscribe", "no such session");
    await expect(p).rejects.toThrow("no such session");
    expect(a.log).toEqual(["begin", "gone no such session", "end"]);
    expect(subs.isLive("s1")).toBe(false);
  });

  it("over a remote link a cold open subscribes inside the history request: one round trip", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 300, subscribe: true }]);
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false, subscribed: true });
    await p;
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "end"]);
    expect(subs.isLive("s1")).toBe(true);
    // Live now: a resume only fetches, without the flag.
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 6 }]);
  });

  it("a remote host that predates the flag: subscribe after the page, then fold the gap, pushes held throughout", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false });
    await flush();
    expect(subs.isLive("s1")).toBe(false);
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }]);
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 6 }]);
    link.answer("session.events", { rows: [row(7)], moreBefore: false, moreAfter: false, reset: false });
    const page = await p;
    expect(page.rows.map((r) => r.seq)).toEqual([5, 6]);
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "page reset=false rows=7", "end"]);
    expect(subs.isLive("s1")).toBe(true);
  });

  it("a remote cold open that fails tells the host to drop the subscription it may have made", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    subs.add("s1", owner(0).handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    link.refuse("session.events", "timed out");
    await expect(p).rejects.toThrow("timed out");
    expect(link.pendingOf("session.unsubscribe")).toEqual([{ sessionId: "s1" }]);
    expect(subs.isLive("s1")).toBe(false);
  });

  it("two resumes in flight for one session share the fetch", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    subs.add("s1", owner(0).handlers);
    const a = subs.resume("s1");
    const b = subs.resume("s1");
    expect(a).toBe(b);
    await expect(subs.resume("nope")).rejects.toThrow("not subscribed");
  });
});
