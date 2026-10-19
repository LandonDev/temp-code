import { getServerPort } from "../native";
import type { ServerFrame, ServerPush } from "./types";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;

/**
 * Where a client connects. No target is the desktop window's case: the
 * in-process server's loopback port, asked of preload again on every
 * reconnect. The browser at `/ui` passes its own origin's `/ws`; a bearer
 * client (thread K1) passes `ticket`, which is asked again on every
 * reconnect so a 30-second single-use ticket is never reused.
 */
export type ConnectTarget = {
  /** `ws://127.0.0.1:1234` or `wss://host/ws`. */
  url: string;
  /** Mint a fresh ticket; it rides as `?ticket=` on the upgrade. */
  ticket?: () => Promise<string>;
};

/**
 * Typed WebSocket client for the in-process server. request() for RPC,
 * onPush for subscription streams. The port comes from preload and is
 * asked for again on every reconnect.
 */
export class WsClient {
  port: number | null = null;
  private target: ConnectTarget | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;

  async connect(target?: ConnectTarget): Promise<void> {
    this.target = target ?? null;
    await this.open(await this.askTarget());
  }

  /** The URL for the next attempt; re-asked on every reconnect. */
  private async askTarget(): Promise<string> {
    if (!this.target) return `ws://127.0.0.1:${await askPort()}`;
    if (!this.target.ticket) return this.target.url;
    const url = new URL(this.target.url);
    url.searchParams.set("ticket", await this.target.ticket());
    return url.toString();
  }


  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.port = portOf(url);
        this.reconnectDelay = RECONNECT_MIN_MS;
        for (const l of this.openListeners) l();
        resolve();
      };
      ws.onerror = () => reject(new Error("websocket error"));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.port = null;
        for (const p of this.pending.values())
          p.reject(new Error("connection closed"));
        this.pending.clear();
        for (const l of this.closeListeners) l();
        this.scheduleReconnect();
      };
      ws.onmessage = (e) => {
        const frame = JSON.parse(e.data as string) as ServerFrame;
        if ("push" in frame) {
          for (const l of this.pushListeners) l(frame);
          return;
        }
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new Error(frame.error));
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.askTarget().then(
        (url) => this.open(url).catch(() => {}),
        () => this.scheduleReconnect(),
      );
    }, delay);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Methods still waiting on a reply, oldest first (the stall log's `pending=`). */
  pendingMethods(): string[] {
    const out: string[] = [];
    for (const p of this.pending.values()) out.push(p.method);
    return out;
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

function askPort(): Promise<number> {
  return getServerPort();
}

function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "wss:" ? 443 : parsed.protocol === "ws:" ? 80 : null;
  } catch {
    return null;
  }
}

export const client = new WsClient();
