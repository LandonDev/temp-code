import { describe, expect, it } from "vitest";
import { createReadMarks, MAX_WAIT_MS, QUIET_MS, type MarkMeta } from "./readMarks";

/** The hosts' read marks on the desktop (CLAUDE.md "Read and unread: the host's mark"). */

function rig(metas: MarkMeta[], hosts: Record<string, string> = {}) {
  const byId = new Map(metas.map((m) => [m.id, m]));
  const metaListeners = new Set<(ids: ReadonlySet<string>) => void>();
  const focusListeners = new Set<() => void>();
  const focus = { attended: null as string | null, shown: null as string | null };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const sent: { env: string; items: { sessionId: string; at: number }[] }[] = [];
  const opens = new Map<string, Set<() => void>>();
  const connected = new Map<string, boolean>();
  const fail = new Set<string>();
  const link = (env: string) => ({
    get connected() {
      return connected.get(env) ?? true;
    },
    request: async (method: string, params: unknown) => {
      expect(method).toBe("session.markRead");
      if (fail.has(env)) throw new Error("dropped");
      sent.push({ env, items: (params as { items: { sessionId: string; at: number }[] }).items });
      return null;
    },
    onOpen: (l: () => void) => {
      const set = opens.get(env) ?? new Set();
      opens.set(env, set);
      set.add(l);
      return () => set.delete(l);
    },
  });
  const marks = createReadMarks({
    metas: () => [...byId.values()],
    metaOf: (id) => byId.get(id) ?? null,
    environmentOf: (id) => (byId.has(id) ? (hosts[id] ?? "local") : undefined),
    onMetaChange: (l) => (metaListeners.add(l), () => metaListeners.delete(l)),
    linkOf: link,
    attended: () => focus.attended,
    shown: () => focus.shown,
    onFocusChange: (l) => (focusListeners.add(l), () => focusListeners.delete(l)),
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const realNow = Date.now;
  Date.now = () => now;
  return {
    marks,
    sent,
    focus,
    connected,
    fail,
    update(meta: MarkMeta) {
      byId.set(meta.id, meta);
      for (const l of metaListeners) l(new Set([meta.id]));
    },
    remove(id: string) {
      byId.delete(id);
      for (const l of metaListeners) l(new Set([id]));
    },
    focusMoved() {
      for (const l of focusListeners) l();
    },
    async advance(ms: number) {
      now += ms;
      for (const t of [...timers].filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    async open(env: string) {
      connected.set(env, true);
      for (const l of [...(opens.get(env) ?? [])]) l();
      await Promise.resolve();
      await Promise.resolve();
    },
    restore: () => void (Date.now = realNow),
  };
}

describe("readMarks", () => {
  it("collects the marks of the hosts that keep them, and leaves the rest to the window", () => {
    const r = rig([
      { id: "a", updatedAt: 100, readAt: 100 },
      { id: "b", updatedAt: 100, readAt: 0 },
      { id: "old", updatedAt: 100 },
    ]);
    expect(r.marks.marks()).toEqual({ a: 100, b: 0 });
    r.update({ id: "b", updatedAt: 100, readAt: 100 });
    expect(r.marks.marks()).toEqual({ a: 100, b: 100 });
    r.remove("a");
    expect(r.marks.marks()).toEqual({ b: 100 });
    r.restore();
  });

  it("Mark all read sends one request per host after a quiet beat, only for what the host does not have", async () => {
    const r = rig(
      [
        { id: "a", updatedAt: 100, readAt: 0 },
        { id: "b", updatedAt: 200, readAt: 200 },
        { id: "c", updatedAt: 300, readAt: 10 },
        { id: "old", updatedAt: 100 },
      ],
      { c: "box" },
    );
    r.marks.read(["a", "b", "c", "old", "gone"], 9_999);
    // Covered at once, before the host answers.
    expect(r.marks.marks()).toEqual({ a: 100, b: 200, c: 300 });
    await r.advance(QUIET_MS - 1);
    expect(r.sent).toEqual([]);
    await r.advance(1);
    expect(r.sent).toEqual([
      { env: "local", items: [{ sessionId: "a", at: 100 }] },
      { env: "box", items: [{ sessionId: "c", at: 300 }] },
    ]);
    r.restore();
  });

  it("follows the thread the person looks at, coalesced, never later than MAX_WAIT_MS", async () => {
    const r = rig([{ id: "a", updatedAt: 100, readAt: 0 }]);
    r.focus.attended = "a";
    r.focus.shown = "a";
    r.focusMoved();
    // The on-screen thread is the window's to say: out of the overlay.
    expect(r.marks.marks()).toEqual({});
    let t = 100;
    for (let i = 0; i < 10; i++) {
      t += 10;
      r.update({ id: "a", updatedAt: t, readAt: 0 });
      await r.advance(QUIET_MS / 2);
    }
    expect(r.sent.length).toBeGreaterThanOrEqual(1);
    expect(r.sent.length).toBeLessThanOrEqual(Math.ceil((10 * QUIET_MS) / 2 / MAX_WAIT_MS) + 1);
    // Each request carries only the newest mark.
    for (const s of r.sent) expect(s.items).toHaveLength(1);
    r.restore();
  });

  it("an unattended window writes nothing: the person may be on the phone", async () => {
    const r = rig([{ id: "a", updatedAt: 100, readAt: 0 }]);
    r.focus.shown = "a";
    r.focusMoved();
    r.update({ id: "a", updatedAt: 200, readAt: 0 });
    await r.advance(MAX_WAIT_MS);
    expect(r.sent).toEqual([]);
    r.restore();
  });

  it("a mark made while the host is away goes out when its link opens again", async () => {
    const r = rig([{ id: "a", updatedAt: 100, readAt: 0 }], { a: "box" });
    r.connected.set("box", false);
    r.marks.read(["a"], 100);
    await r.advance(MAX_WAIT_MS);
    expect(r.sent).toEqual([]);
    await r.open("box");
    expect(r.sent).toEqual([{ env: "box", items: [{ sessionId: "a", at: 100 }] }]);
    r.restore();
  });

  it("a request that fails is sent again at the next open", async () => {
    const r = rig([{ id: "a", updatedAt: 100, readAt: 0 }]);
    r.fail.add("local");
    r.marks.read(["a"], 100);
    await r.advance(QUIET_MS);
    expect(r.sent).toEqual([]);
    r.fail.delete("local");
    await r.open("local");
    expect(r.sent).toEqual([{ env: "local", items: [{ sessionId: "a", at: 100 }] }]);
    // The host's echo clears the window's cover.
    r.update({ id: "a", updatedAt: 100, readAt: 100 });
    expect(r.marks.marks()).toEqual({ a: 100 });
    r.restore();
  });
});
