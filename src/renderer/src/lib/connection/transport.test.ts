import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transport, type SocketLike } from "./transport";
import type { CloseReason } from "./types";

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: [number?, string?] | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code, reason });
  }
  last() {
    return JSON.parse(this.sent[this.sent.length - 1]) as { id: string; method: string; params?: unknown };
  }
}

const HELLO = { push: "hello", environmentId: "env_x", contract: 3, caps: ["read"] };
const make = (url = "ws://127.0.0.1:4000") =>
  new Transport(url, "local", { socket: (u) => new FakeSocket(u), helloTimeoutMs: 1000 });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => vi.useRealTimers());

async function opened() {
  const t = make();
  const p = t.open();
  const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
  ws.receive(HELLO);
  const hello = await p;
  return { t, ws, hello };
}

describe("Transport", () => {
  it("opens the URL as given and resolves on the hello frame", async () => {
    const { t, ws, hello } = await opened();
    expect(ws.url).toBe("ws://127.0.0.1:4000");
    expect(hello).toEqual({ environmentId: "env_x", contract: 3, caps: ["read"] });
    expect(t.state).toBe("open");
    expect(t.hello).toBe(hello);
    await expect(t.open()).resolves.toBe(hello);
  });

  it("carries the ticket or cookie route URL untouched", () => {
    const t = make("wss://box.example/ws?ticket=abc");
    void t.open().catch(() => undefined);
    expect(FakeSocket.instances[0].url).toBe("wss://box.example/ws?ticket=abc");
  });

  it("refuses requests before hello and correlates them after, in any order", async () => {
    const t = make();
    void t.open().catch(() => undefined);
    await expect(t.request("catalog.get")).rejects.toThrow("not connected");
    const ws = FakeSocket.instances[0];
    ws.receive(HELLO);
    const a = t.request<string>("catalog.get");
    const b = t.request<string>("doctor.get", { x: 1 });
    const [ra, rb] = ws.sent.map((s) => JSON.parse(s) as { id: string; method: string });
    expect([ra.method, rb.method]).toEqual(["catalog.get", "doctor.get"]);
    expect(t.pendingMethods()).toEqual(["catalog.get", "doctor.get"]);
    ws.receive({ id: rb.id, ok: true, result: "B" });
    ws.receive({ id: ra.id, ok: false, error: "nope" });
    await expect(b).resolves.toBe("B");
    await expect(a).rejects.toThrow("nope");
    expect(t.pendingMethods()).toEqual([]);
  });

  it("streams pushes but keeps hello to itself", async () => {
    const { t, ws } = await opened();
    const pushes: unknown[] = [];
    t.onPush((p) => pushes.push(p));
    ws.receive({ push: "session-removed", sessionIds: ["s1"] });
    ws.receive(HELLO);
    expect(pushes).toEqual([{ push: "session-removed", sessionIds: ["s1"] }]);
  });

  it("a socket that closes before hello is a network failure", async () => {
    const t = make();
    const p = t.open();
    const reasons: CloseReason[] = [];
    t.onClose((r) => reasons.push(r));
    FakeSocket.instances[0].drop(1006);
    await expect(p).rejects.toThrow("could not connect");
    expect(t.state).toBe("closed");
    expect(t.closeReason).toEqual({ kind: "network", code: 1006, message: "could not connect" });
    expect(reasons).toHaveLength(1);
  });

  it("no hello in time is a protocol failure", async () => {
    const t = make();
    const p = t.open();
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toThrow("no hello");
    expect(t.closeReason?.kind).toBe("protocol");
    expect(FakeSocket.instances[0].closedWith).toEqual([1000, "protocol"]);
  });

  it("4401 and 4403 mean the credential was refused", async () => {
    const { t, ws } = await opened();
    ws.drop(4401, "key revoked");
    expect(t.closeReason).toEqual({ kind: "unauthorized", code: 4401, message: "key revoked" });
    const u = make();
    void u.open().catch(() => undefined);
    FakeSocket.instances[1].drop(4403);
    expect(u.closeReason?.kind).toBe("unauthorized");
  });

  it("a normal server close is reported as such; anything else after hello is a drop", async () => {
    const a = await opened();
    a.ws.drop(1001, "going away");
    expect(a.t.closeReason).toEqual({ kind: "server", code: 1001, message: "going away" });
    const b = await opened();
    b.ws.drop(1006);
    expect(b.t.closeReason).toEqual({ kind: "network", code: 1006, message: "the socket dropped" });
    const c = await opened();
    c.ws.drop();
    expect(c.t.closeReason).toEqual({ kind: "network", message: "the socket dropped" });
  });

  it("close() is synchronous, rejects what was pending, tells listeners once and ignores the late socket event", async () => {
    const { t, ws } = await opened();
    const pending = t.request("catalog.get");
    const reasons: CloseReason[] = [];
    t.onClose((r) => reasons.push(r));
    t.close({ kind: "replaced", message: "better route" });
    expect(t.state).toBe("closed");
    expect(ws.closedWith).toEqual([1000, "replaced"]);
    await expect(pending).rejects.toThrow("connection closed");
    ws.drop(1006);
    t.close();
    expect(reasons).toEqual([{ kind: "replaced", message: "better route" }]);
    await expect(t.request("x")).rejects.toThrow("not connected");
    await expect(t.open()).rejects.toThrow("better route");
  });

  it("a close listener added after the close hears the reason", async () => {
    const { t, ws } = await opened();
    ws.drop(1006);
    const reasons: CloseReason[] = [];
    t.onClose((r) => reasons.push(r));
    expect(reasons.map((r) => r.kind)).toEqual(["network"]);
  });
});
