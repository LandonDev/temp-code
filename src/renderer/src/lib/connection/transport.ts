import type { ServerFrame, ServerPush } from "@server/shared/contract";
import type { WireProfile } from "@server/shared/wire";
import type { CloseReason, Hello } from "./types";

/** What the transport needs from a WebSocket; tests hand in a fake. */
export type SocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type SocketFactory = (url: string) => SocketLike;

export const HELLO_TIMEOUT_MS = 10_000;
/** Close codes the server uses when a credential stops being good. */
const UNAUTHORIZED_CODES = new Set([4401, 4403]);

export type TransportOptions = {
  socket?: SocketFactory;
  helloTimeoutMs?: number;
};

const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/**
 * One socket to one host. `open()` resolves on the `hello` frame, which the
 * server sends first on every socket, so a resolved transport has an
 * identity before any request goes out. Requests correlate by id; pushes
 * stream to `onPush`; `close()` is synchronous and final, and every close,
 * ours or the network's, reaches `onClose` exactly once with its reason.
 */
export class Transport {
  state: "opening" | "open" | "closed" = "opening";
  hello: Hello | null = null;
  closeReason: CloseReason | null = null;
  private ws: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private pushListeners = new Set<(push: ServerPush) => void>();
  private closeListeners = new Set<(reason: CloseReason) => void>();
  private helloWaiters: { resolve: (h: Hello) => void; reject: (e: Error) => void }[] = [];
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly url: string,
    readonly profile: WireProfile,
    private readonly options: TransportOptions = {},
  ) {}

  /** Open the socket and wait for its hello. Rejects with the close reason's message. */
  open(): Promise<Hello> {
    if (this.state === "closed") return Promise.reject(new Error(this.closeReason?.message ?? "closed"));
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise<Hello>((resolve, reject) => {
      this.helloWaiters.push({ resolve, reject });
      if (this.ws) return;
      const ws = (this.options.socket ?? defaultSocket)(this.url);
      this.ws = ws;
      this.helloTimer = setTimeout(
        () => this.close({ kind: "protocol", message: "no hello from the server" }),
        this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
      );
      ws.onopen = null;
      ws.onerror = null; // the close that follows carries the outcome
      ws.onclose = (event) => this.onSocketClose(ws, event);
      ws.onmessage = (e) => this.onMessage(e.data);
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.state !== "open" || !this.ws) return Promise.reject(new Error("not connected"));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Methods still waiting on a reply, oldest first. */
  pendingMethods(): string[] {
    const out: string[] = [];
    for (const p of this.pending.values()) out.push(p.method);
    return out;
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onClose(listener: (reason: CloseReason) => void): () => void {
    if (this.state === "closed" && this.closeReason) listener(this.closeReason);
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Close for our own reasons; the socket's later close event is ignored. */
  close(reason: CloseReason = { kind: "local", message: "closed" }): void {
    if (this.state === "closed") return;
    const ws = this.ws;
    this.finish(reason);
    try {
      ws?.close(1000, reason.kind);
    } catch {
      /* already closing */
    }
  }

  private onMessage(data: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if ("push" in frame) {
      if (frame.push === "hello") {
        if (this.hello) return;
        this.hello = {
          environmentId: frame.environmentId,
          contract: frame.contract,
          caps: frame.caps,
          ...(frame.key ? { key: frame.key } : {}),
          ...(frame.build ? { build: frame.build } : {}),
        };
        this.state = "open";
        this.clearHelloTimer();
        const waiters = this.helloWaiters;
        this.helloWaiters = [];
        for (const w of waiters) w.resolve(this.hello);
        return;
      }
      for (const l of this.pushListeners) l(frame);
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.result);
    else p.reject(new Error(frame.error));
  }

  private onSocketClose(ws: SocketLike, event?: { code?: number; reason?: string }): void {
    if (this.ws !== ws || this.state === "closed") return;
    const code = event?.code;
    const reason: CloseReason =
      code !== undefined && UNAUTHORIZED_CODES.has(code)
        ? { kind: "unauthorized", code, message: event?.reason || "the server refused this credential" }
        : code === 1000 || code === 1001
          ? { kind: "server", code, message: event?.reason || "the server closed the socket" }
          : {
              kind: "network",
              ...(code !== undefined ? { code } : {}),
              message: this.hello ? "the socket dropped" : "could not connect",
            };
    this.finish(reason);
  }

  private finish(reason: CloseReason): void {
    this.state = "closed";
    this.closeReason = reason;
    this.clearHelloTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const w of waiters) w.reject(new Error(reason.message));
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
    this.pushListeners.clear();
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }
}
