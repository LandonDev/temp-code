import type { Transport } from "./transport";
import type { Clock } from "./supervisor";
import type { CloseReason, Hello } from "./types";

/** Manual time for the supervisor tests: timers fire only on `advance`. */
export class FakeClock implements Clock {
  t = 1_000_000;
  randomValue = 0.5;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  random(): number {
    return this.randomValue;
  }
  get pending(): number[] {
    return this.timers.map((x) => x.at - this.t).sort((a, b) => a - b);
  }
  /** Fire every timer due within `ms`, in order, letting promises settle between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers].filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      this.timers = this.timers.filter((x) => x !== due);
      due.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export const HELLO: Hello = { environmentId: "env_host", contract: 3, caps: ["read", "operate"] };

/** A scripted stand-in for Transport: the test answers hello, fails or drops it. */
export class FakeTransport {
  state: "opening" | "open" | "closed" = "opening";
  hello: Hello | null = null;
  closeReason: CloseReason | null = null;
  requests: { method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private closeListeners = new Set<(r: CloseReason) => void>();
  private opened: Promise<Hello>;
  private resolveOpen!: (h: Hello) => void;
  private rejectOpen!: (e: Error) => void;
  constructor(
    public url: string,
    public profile: string,
  ) {
    this.opened = new Promise<Hello>((res, rej) => {
      this.resolveOpen = res;
      this.rejectOpen = rej;
    });
    this.opened.catch(() => undefined);
  }
  open(): Promise<Hello> {
    return this.opened;
  }
  answerHello(hello: Hello = HELLO): void {
    this.state = "open";
    this.hello = hello;
    this.resolveOpen(hello);
  }
  failOpen(reason: CloseReason = { kind: "network", message: "could not connect" }): void {
    this.state = "closed";
    this.closeReason = reason;
    this.rejectOpen(new Error(reason.message));
    for (const l of this.closeListeners) l(reason);
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== "open") return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => this.requests.push({ method, params, resolve, reject }));
  }
  pendingMethods(): string[] {
    return this.requests.map((r) => r.method);
  }
  onPush(): () => void {
    return () => undefined;
  }
  onClose(l: (r: CloseReason) => void): () => void {
    if (this.state === "closed" && this.closeReason) l(this.closeReason);
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }
  close(reason: CloseReason = { kind: "local", message: "closed" }): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closeReason = reason;
    for (const r of this.requests) r.reject(new Error("connection closed"));
    this.requests = [];
    for (const l of this.closeListeners) l(reason);
  }
  /** The network took the socket. */
  drop(): void {
    this.close({ kind: "network", message: "the socket dropped" });
  }
  asTransport(): Transport {
    return this as unknown as Transport;
  }
}
