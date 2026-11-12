import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerHistoryCall, ComputerHistoryStep, ComputerSessionRow } from "@server/shared/contract-computer";
import { macComputerKey } from "@server/shared/contract-maccomputer";

type Push = { push: string; key?: string; call?: ComputerHistoryCall; gone?: true };
interface FakeLink {
  environmentId: string;
  connected: boolean;
  request: (method: string, params: unknown) => Promise<unknown>;
  onPush: (fn: (push: Push) => void) => void;
  onOpen: (fn: () => void) => void;
  push?: (p: Push) => void;
  open?: () => void;
}
const links = vi.hoisted(() => ({ listeners: new Set<(link: unknown, event: string) => void>(), local: null as unknown }));
vi.mock("./connection/registry", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  registry: {
    onLink: (fn: (link: unknown, event: string) => void) => {
      links.listeners.add(fn);
      return () => links.listeners.delete(fn);
    },
    link: () => links.local ?? undefined,
    statusOf: () => ({ lastHello: { environmentId: "env_mac" } }),
  },
}));
vi.mock("./native", () => ({ nativePlatform: () => "darwin" }));
vi.mock("./nativeWeb", () => ({ isWebMode: () => false }));

const H = await import("./computerHistory");
const { entriesOf } = await import("./computerSessions");

const step = (verb: string, object = "Save", over: Partial<ComputerHistoryStep> = {}): ComputerHistoryStep => ({ kind: "click", verb, object, inApp: object ? `${object} in TextEdit` : "in TextEdit", state: "ok", ...over });
const call = (n: number, over: Partial<ComputerHistoryCall> = {}): ComputerHistoryCall => ({
  n,
  turn: 1,
  at: n * 1000,
  endedAt: n * 1000 + 500,
  state: "done",
  app: "TextEdit",
  window: "Untitled",
  steps: [step("Clicked")],
  text: false,
  rev: 2,
  ...over,
});

/** This Mac's link: answers reads from `journal`, records each request. */
function localLink(journal: Record<string, { born: number; calls: ComputerHistoryCall[]; more?: boolean }>) {
  const requests: { method: string; params: { keys?: string[]; before?: number; key?: string; n?: number } }[] = [];
  let fail = false;
  const link: FakeLink = {
    environmentId: "local",
    connected: true,
    request: async (method, params) => {
      requests.push({ method, params: params as never });
      if (fail) throw new Error("unknown method");
      const p = params as { keys: string[]; before?: number };
      if (method === "computer.history.read")
        return {
          sessions: p.keys.map((key) => {
            const held = journal[key];
            const calls = (held?.calls ?? []).filter((c) => p.before === undefined || c.n < p.before);
            return { key, born: held?.born ?? 0, calls, more: p.before === undefined ? (held?.more ?? false) : false };
          }),
        };
      return {};
    },
    onPush: (fn) => (link.push = fn),
    onOpen: (fn) => (link.open = fn),
  };
  links.local = link;
  for (const l of links.listeners) l(link, "added");
  return { link, requests, failNext: (on: boolean) => (fail = on) };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const held = (key: string) => H.computerHistoryStore.getState().byKey[key];

beforeEach(() => {
  H.resetComputerHistory();
  links.local = null;
});

describe("historyKeys", () => {
  const mac = { macDesktop: true };
  it("a Mac thread's tree reads by each thread's own id", () => {
    expect(H.historyKeys(new Set(["t1", "sub1"]), "local", mac)).toEqual([
      { threadId: "t1", key: "t1" },
      { threadId: "sub1", key: "sub1" },
    ]);
  });
  it("a box thread's tree reads by the bridge's key on this Mac", () => {
    expect(H.historyKeys(new Set(["b1", "b2"]), "env_box", mac)).toEqual([
      { threadId: "b1", key: macComputerKey("env_box", "b1") },
      { threadId: "b2", key: macComputerKey("env_box", "b2") },
    ]);
  });
  it("nothing off a Mac's desktop: the browser, a Linux desktop", () => {
    expect(H.historyKeys(new Set(["t1"]), "local", { macDesktop: false })).toEqual([]);
    expect(H.historyKeys(new Set(["b1"]), "env_box", { macDesktop: false })).toEqual([]);
  });
  it("65 keys are two reads", async () => {
    const keys = Array.from({ length: 65 }, (_, i) => `t${i}`);
    expect(H.keyChunks(keys).map((c) => c.length)).toEqual([64, 1]);
    H.startComputerHistory();
    const { requests } = localLink({});
    const off = H.watchHistory(keys);
    await settle();
    expect(requests.map((r) => r.params.keys!.length)).toEqual([64, 1]);
    off();
  });
});

describe("the join with the live row", () => {
  it("a box thread's row on the box's push joins this Mac's journal under the bridge's key", () => {
    const row: ComputerSessionRow = { threadId: "b1", since: 1, lastCallAt: 1, apps: [], running: null, tier: null, macPeer: "env_mac", macName: "Mac" };
    const [entry] = entriesOf([row], new Set(["b1"]), "env_box", { macDesktop: true, localId: "env_mac" });
    const [key] = H.historyKeys(new Set(["b1"]), "env_box", { macDesktop: true });
    expect(H.historyKeyOf(entry)).toBe(key.key);
    // a Mac thread's own row joins by its id
    const [own] = entriesOf([{ ...row, threadId: "t1", macPeer: undefined }], new Set(["t1"]), "local", { macDesktop: true, localId: "env_mac" });
    expect(H.historyKeyOf(own)).toBe("t1");
    // a session this desktop cannot draw has no journal here
    const [other] = entriesOf([{ ...row, macPeer: "env_other_mac" }], new Set(["b1"]), "env_box", { macDesktop: true, localId: "env_mac" });
    expect(H.historyKeyOf(other)).toBeNull();
  });
});

describe("mergeCall and mergeRead", () => {
  it("a newer revision wins, an older or equal one changes nothing", () => {
    const calls = [call(1), call(2), call(3)];
    expect(H.mergeCall(calls, call(2, { rev: 2 }))).toBe(calls);
    expect(H.mergeCall(calls, call(2, { rev: 1, state: "running" }))).toBe(calls);
    const next = H.mergeCall(calls, call(2, { rev: 3, picture: { none: "off" } }));
    expect(next[1].rev).toBe(3);
    // the calls that did not change are the objects they were
    expect(next[0]).toBe(calls[0]);
    expect(next[2]).toBe(calls[2]);
  });
  it("a new call lands in order, wherever it belongs", () => {
    const calls = [call(2), call(4)];
    expect(H.mergeCall(calls, call(5)).map((c) => c.n)).toEqual([2, 4, 5]);
    expect(H.mergeCall(calls, call(3)).map((c) => c.n)).toEqual([2, 3, 4]);
    expect(H.mergeCall(calls, call(1)).map((c) => c.n)).toEqual([1, 2, 4]);
    expect(H.mergeCall([], call(1)).map((c) => c.n)).toEqual([1]);
  });
  it("an old read never undoes a newer push", () => {
    const pushed = call(3, { rev: 3, picture: { width: 960, height: 804, at: 9 } });
    const now: import("./computerHistory").KeyHistory = { born: 10, calls: [call(1), call(2), pushed], more: false, status: "ready" };
    const merged = H.mergeRead(now, { born: 10, calls: [call(1), call(2), call(3, { rev: 2 })], more: false });
    expect(merged.calls[2]).toBe(pushed);
    expect(merged.calls[0]).toBe(now.calls[0]);
  });
  it("a push heard before the first read stays when the read lands without it", () => {
    const early = call(4, { rev: 1, state: "running" });
    const loading: import("./computerHistory").KeyHistory = { born: 0, calls: [early], more: false, status: "loading" };
    const merged = H.mergeRead(loading, { born: 10, calls: [call(1), call(2), call(3)], more: true });
    expect(merged).toMatchObject({ born: 10, more: true, status: "ready" });
    expect(merged.calls.map((c) => c.n)).toEqual([1, 2, 3, 4]);
    expect(merged.calls[3]).toBe(early);
  });
  it("a new born empties the key: its numbers started over", () => {
    const now: import("./computerHistory").KeyHistory = { born: 10, calls: [call(1), call(2), call(3)], more: true, status: "ready" };
    const merged = H.mergeRead(now, { born: 99, calls: [call(1, { rev: 1, state: "running" })], more: false });
    expect(merged).toEqual({ born: 99, calls: [call(1, { rev: 1, state: "running" })], more: false, status: "ready" });
  });
  it("older pages merge under what is held, and more follows the oldest call held", () => {
    const newest: import("./computerHistory").KeyHistory = { born: 10, calls: [call(201), call(202)], more: true, status: "ready" };
    const older = H.mergeRead(newest, { born: 10, calls: [call(1), call(2)], more: false }, true);
    expect(older.calls.map((c) => c.n)).toEqual([1, 2, 201, 202]);
    expect(older.more).toBe(false);
    // the newest page read again (a reconnect) does not bring `more` back while older calls are held
    const again = H.mergeRead(older, { born: 10, calls: [call(201), call(202), call(203)], more: true });
    expect(again.calls.map((c) => c.n)).toEqual([1, 2, 201, 202, 203]);
    expect(again.more).toBe(false);
  });
});

describe("the store", () => {
  it("listens before it reads, follows the push, and reads again on a new socket", async () => {
    H.startComputerHistory();
    const { link, requests } = localLink({ t1: { born: 10, calls: [call(1), call(2)] } });
    // the push listener is on before any read goes out
    expect(link.push).toBeTypeOf("function");
    expect(requests).toEqual([]);
    const off = H.watchHistory(["t1"]);
    expect(held("t1")).toMatchObject({ status: "loading", calls: [] });
    await settle();
    expect(held("t1")).toMatchObject({ born: 10, status: "ready" });
    expect(held("t1").calls.map((c) => c.n)).toEqual([1, 2]);
    const before = held("t1").calls;
    link.push!({ push: "computer-history", key: "t1", call: call(3, { rev: 1, state: "running" }) });
    expect(held("t1").calls.map((c) => [c.n, c.state])).toEqual([[1, "done"], [2, "done"], [3, "running"]]);
    expect(held("t1").calls[0]).toBe(before[0]);
    // a push that is not newer changes nothing, not even the state object
    const same = H.computerHistoryStore.getState();
    link.push!({ push: "computer-history", key: "t1", call: call(3, { rev: 1, state: "running" }) });
    link.push!({ push: "computer", key: "t1" });
    link.push!({ push: "computer-history", key: "nobody", call: call(1) });
    expect(H.computerHistoryStore.getState()).toBe(same);
    // a new socket: the host's subscription died with the old one, so the keys on screen are read again
    expect(requests).toHaveLength(1);
    link.open!();
    await settle();
    expect(requests.map((r) => r.params.keys)).toEqual([["t1"], ["t1"]]);
    off();
    // nobody reads it any more: dropped, and its pushes ignored
    expect(held("t1")).toBeUndefined();
    link.push!({ push: "computer-history", key: "t1", call: call(4) });
    expect(held("t1")).toBeUndefined();
  });

  it("two readers of one key read it once and keep it until both leave", async () => {
    H.startComputerHistory();
    const { requests } = localLink({ t1: { born: 10, calls: [call(1)] } });
    const a = H.watchHistory(["t1"]);
    const b = H.watchHistory(["t1"]);
    await settle();
    expect(requests).toHaveLength(1);
    a();
    expect(held("t1").calls).toHaveLength(1);
    b();
    expect(held("t1")).toBeUndefined();
  });

  it("gone empties the key, and a history begun again fills it", async () => {
    H.startComputerHistory();
    const { link } = localLink({ t1: { born: 10, calls: [call(1), call(2)] } });
    const off = H.watchHistory(["t1"]);
    await settle();
    link.push!({ push: "computer-history", key: "t1", gone: true });
    expect(held("t1")).toEqual({ born: 0, calls: [], more: false, status: "ready" });
    link.push!({ push: "computer-history", key: "t1", call: call(1, { rev: 1, state: "running", at: 50_000 }) });
    expect(held("t1").calls.map((c) => [c.n, c.at])).toEqual([[1, 50_000]]);
    off();
  });

  it("older pages are read under the oldest call held", async () => {
    H.startComputerHistory();
    const all = Array.from({ length: 5 }, (_, i) => call(i + 1));
    const journal = { t1: { born: 10, calls: all.slice(3), more: true } };
    const { requests } = localLink(journal);
    const off = H.watchHistory(["t1"]);
    await settle();
    expect(held("t1")).toMatchObject({ more: true });
    journal.t1.calls = all;
    await H.loadOlderHistory("t1");
    expect(requests.at(-1)!.params).toEqual({ keys: ["t1"], before: 4 });
    expect(held("t1").calls.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(held("t1").more).toBe(false);
    // nothing older: no request
    await H.loadOlderHistory("t1");
    expect(requests).toHaveLength(2);
    off();
  });

  it("a read that fails says so, and Retry asks again", async () => {
    H.startComputerHistory();
    const { requests, failNext } = localLink({ t1: { born: 10, calls: [call(1)] } });
    failNext(true);
    const off = H.watchHistory(["t1"]);
    await settle();
    expect(held("t1")).toMatchObject({ status: "failed", calls: [] });
    failNext(false);
    H.retryHistory(["t1"]);
    expect(held("t1").status).toBe("loading");
    await settle();
    expect(held("t1")).toMatchObject({ status: "ready" });
    expect(requests).toHaveLength(2);
    off();
  });

  it("a read cut off by a dropped socket is no failure: the key waits, and is read again when the socket opens", async () => {
    H.startComputerHistory();
    const { link, requests, failNext } = localLink({ t1: { born: 10, calls: [call(1)] } });
    failNext(true);
    const off = H.watchHistory(["t1"]);
    // the socket goes while the read is out
    link.connected = false;
    await settle();
    expect(held("t1")).toMatchObject({ status: "loading", calls: [] });
    failNext(false);
    link.connected = true;
    link.open?.();
    await settle();
    expect(held("t1")).toMatchObject({ status: "ready" });
    expect(requests).toHaveLength(2);
    off();
  });

  it("a picture the host no longer has is marked gone", async () => {
    H.startComputerHistory();
    localLink({ t1: { born: 10, calls: [call(1, { picture: { width: 9, height: 9, at: 1 } }), call(2)] } });
    const off = H.watchHistory(["t1"]);
    await settle();
    const two = held("t1").calls[1];
    H.markPictureGone("t1", 1);
    expect(held("t1").calls[0].picture).toEqual({ none: "gone" });
    expect(held("t1").calls[1]).toBe(two);
    const same = H.computerHistoryStore.getState();
    H.markPictureGone("t1", 2);
    H.markPictureGone("t1", 1);
    expect(H.computerHistoryStore.getState()).toBe(same);
    off();
  });

  it("hasHistory says whether any key holds a call", () => {
    expect(H.hasHistory({})).toBe(false);
    expect(H.hasHistory({ t1: { born: 0, calls: [], more: false, status: "loading" } })).toBe(false);
    expect(H.hasHistory({ t1: { born: 0, calls: [], more: false, status: "ready" }, t2: { born: 1, calls: [call(1)], more: false, status: "ready" } })).toBe(true);
  });
});

describe("rowsOf", () => {
  const words = (rows: { step: ComputerHistoryStep; namesApp: boolean }[]): string[] => rows.map((r) => `${r.step.verb} ${r.namesApp || !r.step.object ? r.step.inApp : r.step.object}`);

  it("one row per step, newest first, the running call apart", () => {
    const list = H.rowsOf([
      {
        key: "t1",
        threadId: "t1",
        calls: [
          call(1, { steps: [step("Read", "", { kind: "read", inApp: "TextEdit" })] }),
          call(2, { steps: [step("Clicked"), step("Typed", "into Save As", { kind: "type" }), step("Pressed", "super+s", { kind: "key" })] }),
          call(3, { state: "running", endedAt: undefined, rev: 1, steps: [step("Clicking", "Replace", { state: undefined })] }),
        ],
      },
    ]);
    expect(list.running.map((r) => [r.call.n, r.step.verb, r.whole])).toEqual([[3, "Clicking", true]]);
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].rows.map((r) => `${r.call.n}.${r.index}`)).toEqual(["2.2", "2.1", "2.0", "1.0"]);
    expect(list.groups[0].rows.map((r) => r.id)).toEqual(["t1:2:2", "t1:2:1", "t1:2:0", "t1:1:0"]);
  });

  it("a row names its app only where it changes, and the oldest of a group always does", () => {
    const list = H.rowsOf([
      {
        key: "t1",
        threadId: "t1",
        calls: [
          call(1, { steps: [step("Clicked", "New Document")] }),
          call(2, { steps: [step("Typed", "into Subject", { kind: "type" })] }),
          call(3, { app: "Mail", steps: [step("Clicked", "Send", { inApp: "Send in Mail" })] }),
          call(4, { app: "Mail", steps: [step("Clicked", "", { inApp: "in Mail" })] }),
          call(5, { steps: [step("Pressed", "super+s", { kind: "key" })] }),
        ],
      },
    ]);
    expect(words(list.groups[0].rows)).toEqual(["Pressed super+s in TextEdit", "Clicked in Mail", "Clicked Send in Mail", "Typed into Subject", "Clicked New Document in TextEdit"]);
  });

  it("groups are a session's turns; a heading stands only where two groups meet", () => {
    const list = H.rowsOf([
      {
        key: "t1",
        threadId: "t1",
        calls: [call(1, { turn: 1 }), call(2, { turn: 1 }), call(3, { turn: 2, at: 50_000 }), call(4, { turn: 2, at: 60_000 })],
      },
    ]);
    expect(list.groups.map((g) => [g.id, g.heading, g.rows.map((r) => r.call.n)])).toEqual([
      ["t1:2", null, [4, 3]],
      ["t1:1", { at: 1000 }, [2, 1]],
    ]);
    // the oldest row of each group names its app
    expect(list.groups.map((g) => g.rows.at(-1)!.namesApp)).toEqual([true, true]);
  });

  it("a subagent's group leads with its title, the newest one too", () => {
    const list = H.rowsOf([
      { key: "t1", threadId: "t1", calls: [call(1, { at: 1000 })] },
      { key: "sub1", threadId: "sub1", title: "Fill in the form", calls: [call(1, { at: 9000 }), call(2, { at: 9500 })] },
    ]);
    expect(list.groups.map((g) => [g.id, g.heading])).toEqual([
      ["sub1:1", { at: 9000, title: "Fill in the form" }],
      ["t1:1", { at: 1000 }],
    ]);
  });

  it("a call that never finished is one row for the whole call", () => {
    const list = H.rowsOf([
      {
        key: "t1",
        threadId: "t1",
        calls: [call(1), call(2, { state: "unfinished", endedAt: undefined, rev: 1, steps: [step("Clicking", "To", { state: undefined }), step("Typing", "into Subject", { state: undefined })], plan: ["click", "type"] })],
      },
    ]);
    expect(list.running).toEqual([]);
    expect(list.groups[0].rows.map((r) => [r.call.n, r.index, r.whole])).toEqual([[2, 0, true], [1, 0, false]]);
  });

  it("two live sessions: both running calls, the one that started last first", () => {
    const running = (n: number, at: number): ComputerHistoryCall => call(n, { state: "running", endedAt: undefined, rev: 1, at, steps: [step("Clicking", "Save", { state: undefined })] });
    const list = H.rowsOf([
      { key: "t1", threadId: "t1", calls: [running(1, 1000)] },
      { key: "sub1", threadId: "sub1", title: "Sub", calls: [running(1, 5000)] },
    ]);
    expect(list.running.map((r) => r.key)).toEqual(["sub1", "t1"]);
    expect(list.groups).toEqual([]);
    expect(H.flatRows(list)).toEqual([]);
  });

  it("nothing in, nothing out", () => {
    expect(H.rowsOf([])).toEqual({ running: [], groups: [] });
    expect(H.rowsOf([{ key: "t1", threadId: "t1", calls: [] }])).toEqual({ running: [], groups: [] });
  });
});

describe("nowState", () => {
  const row = (over: Partial<ComputerSessionRow>): ComputerSessionRow => ({ threadId: "t1", since: 1, lastCallAt: 1, apps: [], running: null, tier: null, ...over });
  it("a card waits, a held step is queued, a running call works, and between calls it is nothing", () => {
    const running = { tool: "computer_act", words: "Clicking Save in TextEdit", startedAt: 1 };
    expect(H.nowState(row({ running, asking: { line: "Click Save in TextEdit?" } }))).toBe("waiting");
    expect(H.nowState(row({ running: { ...running, words: "Waiting for the Mac to be free", held: true } }))).toBe("queued");
    expect(H.nowState(row({ running }))).toBe("working");
    expect(H.nowState(row({}))).toBeNull();
  });
});
