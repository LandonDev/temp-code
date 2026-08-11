import type { ServerFrame, ServerPush } from '@shared/contract'

/**
 * Typed websocket client. request() for RPC, onPush for subscription
 * streams. Reconnects with backoff; resubscribes are the store's job
 * (it knows which sessions are open).
 */
export class WsClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private pushListeners = new Set<(push: ServerPush) => void>()
  private openListeners = new Set<() => void>()
  private closeListeners = new Set<() => void>()

  async connect(): Promise<void> {
    const port = await window.api.getServerPort()
    if (!port) throw new Error('server not running')
    await this.open(port)
  }

  private open(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      this.ws = ws
      ws.onopen = (): void => {
        for (const l of this.openListeners) l()
        resolve()
      }
      ws.onerror = (): void => reject(new Error('websocket error'))
      ws.onclose = (): void => {
        for (const p of this.pending.values()) p.reject(new Error('connection closed'))
        this.pending.clear()
        for (const l of this.closeListeners) l()
        setTimeout(() => void this.open(port).catch(() => {}), 1000)
      }
      ws.onmessage = (e): void => {
        const frame = JSON.parse(e.data) as ServerFrame
        if ('push' in frame) {
          for (const l of this.pushListeners) l(frame)
        } else {
          const p = this.pending.get(frame.id)
          if (!p) return
          this.pending.delete(frame.id)
          if (frame.ok) p.resolve(frame.result)
          else p.reject(new Error(frame.error))
        }
      }
    })
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener)
    return () => this.pushListeners.delete(listener)
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener)
    return () => this.openListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }
}

export const client = new WsClient()
