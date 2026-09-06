import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServerPort = vi.fn<() => Promise<number>>();
vi.mock("../native", () => ({ getServerPort: () => getServerPort() }));

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.drop();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  lastRequest() {
    return JSON.parse(this.sent[this.sent.length - 1]) as { id: string; method: string };
  }
}

const { WsClient } = await import("./client");

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  getServerPort.mockReset();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected() {
  getServerPort.mockResolvedValueOnce(4000);
  const client = new WsClient();
  const p = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeSocket.instances[0];
  ws.open();
  await p;
  return { client, ws };
}

describe("WsClient", () => {
  it("asks Rust for the port and connects to it", async () => {
    const { client, ws } = await connected();
    expect(getServerPort).toHaveBeenCalled();
    expect(ws.url).toBe("ws://127.0.0.1:4000");
    expect(client.port).toBe(4000);
  });

  it("correlates responses to requests by id, in any order", async () => {
    const { client, ws } = await connected();
    const a = client.request<string>("catalog.get");
    const b = client.request<string>("doctor.get");
    const [ra, rb] = ws.sent.map((s) => JSON.parse(s) as { id: string; method: string });
    expect([ra.method, rb.method]).toEqual(["catalog.get", "doctor.get"]);
    ws.receive({ id: rb.id, ok: true, result: "B" });
    ws.receive({ id: ra.id, ok: false, error: "nope" });
    await expect(b).resolves.toBe("B");
    await expect(a).rejects.toThrow("nope");
  });

  it("fans pushes out to every listener", async () => {
    const { client, ws } = await connected();
    const seen: string[] = [];
    client.onPush((p) => seen.push(`1:${p.push}`));
    const off = client.onPush((p) => seen.push(`2:${p.push}`));
    ws.receive({ push: "session-removed", sessionIds: [] });
    off();
    ws.receive({ push: "session-removed", sessionIds: [] });
    expect(seen).toEqual(["1:session-removed", "2:session-removed", "1:session-removed"]);
  });

  it("rejects in-flight requests and re-asks for the port on reconnect", async () => {
    const { client, ws } = await connected();
    const inflight = client.request("catalog.get");
    getServerPort.mockResolvedValueOnce(4001);
    ws.drop();
    await expect(inflight).rejects.toThrow("connection closed");
    expect(client.port).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[1];
    expect(next.url).toBe("ws://127.0.0.1:4001");
    next.open();
    expect(client.port).toBe(4001);
  });

  it("backs off when Rust has no port yet, capped at 5 s", async () => {
    const { ws } = await connected();
    getServerPort.mockRejectedValue(new Error("server is not running"));
    ws.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getServerPort).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getServerPort).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(getServerPort).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getServerPort).toHaveBeenCalledTimes(5);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
