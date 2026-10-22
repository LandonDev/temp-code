import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvLink, RETRY_BACKOFF_MS, retryDelay } from "./link";
import { ConnectionLostError, TimeoutError, type Transport } from "./transport";

/** A transport the test answers by hand; the link only sees its surface. */
class Scripted {
  state: "open" | "closed" = "open";
  profile = "local" as const;
  calls: { method: string; options: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private answers = new Set<(ms: number, timedOut: boolean) => void>();
  private closes = new Set<() => void>();
  request(method: string, _params?: unknown, options?: unknown): Promise<unknown> {
    if (this.state !== "open") return Promise.reject(new ConnectionLostError("not connected"));
    return new Promise((resolve, reject) => this.calls.push({ method, options, resolve, reject }));
  }
  onPush(): () => void {
    return () => undefined;
  }
  onAnswer(l: (ms: number, timedOut: boolean) => void): () => void {
    this.answers.add(l);
    return () => this.answers.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closes.add(l);
    return () => this.closes.delete(l);
  }
  answer(ms: number, timedOut = false): void {
    for (const l of this.answers) l(ms, timedOut);
  }
  drop(): void {
    this.state = "closed";
    for (const c of this.calls) c.reject(new ConnectionLostError("connection closed"));
    this.calls = [];
    for (const l of this.closes) l();
  }
  asTransport(): Transport {
    return this as unknown as Transport;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("EnvLink", () => {
  it("backs off 1, 2, 4, 8 then 15 s", () => {
    expect(RETRY_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it("asks a safe read again on a new socket after the old one dropped", async () => {
    const link = new EnvLink("box", "remote");
    const first = new Scripted();
    link.setSession(first.asTransport());
    const read = link.request<string>("session.events", { sessionId: "s1" });
    expect(first.calls.map((c) => c.method)).toEqual(["session.events"]);
    first.drop();
    await settle();
    // Down: the first retry finds no socket and waits its turn.
    await vi.advanceTimersByTimeAsync(1000);
    const second = new Scripted();
    link.setSession(second.asTransport());
    await settle();
    expect(second.calls.map((c) => c.method)).toEqual(["session.events"]);
    second.calls[0].resolve("rows");
    await expect(read).resolves.toBe("rows");
  });

  it("asks a safe read again after a timeout, on the same socket", async () => {
    const link = new EnvLink("box", "remote");
    const t = new Scripted();
    link.setSession(t.asTransport());
    const read = link.request<string>("notes.get", { sessionId: "s1" });
    t.calls[0].reject(new TimeoutError("notes.get", 30_000));
    await settle();
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toHaveLength(2);
    t.calls[1].resolve("notes");
    await expect(read).resolves.toBe("notes");
  });

  it("never replays a write, never retries the host's own refusal, and gives up after the backoff", async () => {
    const link = new EnvLink("box", "remote");
    const t = new Scripted();
    link.setSession(t.asTransport());
    const write = link.request("session.send", { sessionId: "s1", text: "hi" }).catch((e: unknown) => e);
    t.calls[0].reject(new TimeoutError("session.send", 30_000));
    expect(await write).toBeInstanceOf(TimeoutError);
    const refused = link.request("session.events", {}).catch((e: unknown) => e);
    t.calls[1].reject(new Error("unknown session"));
    expect(((await refused) as Error).message).toBe("unknown session");
    expect(t.calls).toHaveLength(2);

    t.drop();
    const down = link.request("fs.read", { path: "/x" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 15000);
    expect(await down).toBeInstanceOf(ConnectionLostError);
  });

  it("a caller may turn the retry off", async () => {
    const link = new EnvLink("box", "remote");
    const t = new Scripted();
    link.setSession(t.asTransport());
    const read = link.request("session.events", {}, { retry: false }).catch((e: unknown) => e);
    t.drop();
    expect(await read).toBeInstanceOf(ConnectionLostError);
  });

  it("is slow after a late answer or a timeout until the next quick answer", () => {
    const link = new EnvLink("box", "remote");
    const t = new Scripted();
    link.setSession(t.asTransport());
    let heard = 0;
    link.onHealth(() => heard++);
    t.answer(200);
    expect(link.health).toEqual({ slowSince: null, lastAnswerMs: 200 });
    vi.setSystemTime(50_000);
    t.answer(12_000);
    expect(link.health).toEqual({ slowSince: 50_000, lastAnswerMs: 12_000 });
    vi.setSystemTime(60_000);
    t.answer(30_000, true);
    expect(link.health.slowSince).toBe(50_000);
    t.answer(150);
    expect(link.health).toEqual({ slowSince: null, lastAnswerMs: 150 });
    expect(heard).toBe(2);
  });
});
