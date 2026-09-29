import { getServerPort } from "../native";
import type { ServerFrame, ServerPush } from "./types";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;

/**
 * Typed WebSocket client for the in-process server. request() for RPC,
 * onPush for subscription streams. The port comes from preload and is
 * asked for again on every reconnect.
 */
export class WsClient {
  port: number | null = null;
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

  async connect(): Promise<void> {
    await this.open(await askPort());
  }


  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private open(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws = ws;
      ws.onopen = () => {
        this.port = port;
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
      askPort().then(
        (port) => this.open(port).catch(() => {}),
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

export const client = new WsClient();
