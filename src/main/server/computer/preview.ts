import type { ClientRequest } from '@shared/contract'
import {
  PREVIEW_MIN_EDGE,
  PREVIEW_MAX_EDGE,
  type ComputerClickPush,
  type ComputerFramePush,
  type ComputerPreviewStart,
  type ComputerPreviewPush,
  type ComputerPreviewEndReason
} from '@shared/contract-computer'
import type { ComputerNotification } from '@shared/computer/protocol'
import { ComputerRpcError } from './connection'
import { PreviewGate } from './previewGate'
import type { Clock, ComputerService } from './service'
import type { ComputerSessions } from './sessions'

export interface Viewer {
  connection: object
  send: (frame: ComputerFramePush | ComputerClickPush | ComputerPreviewPush) => void
}
export interface PreviewTarget {
  serviceSession: string
  app: { pid: number; name: string }
  window: { id: number; title: string | null }
}
interface Watcher {
  id: string
  viewer: Viewer
  maxEdge: number
  /** clicks that came before its start answer went out: sent once it is ready, since the client drops a push for an id it does not know */
  early: ComputerClickPush[] | null
}
interface Stream {
  threadId: string
  watchers: Map<string, Watcher>
  gate: PreviewGate<ComputerFramePush>
  stream: string | null
  routed: boolean
  edge: number
  answer: Omit<ComputerPreviewStart, 'preview' | 'ended'>
  /** why the stream last ended, until one starts again: a start that lands on it says so in its answer */
  ended: ComputerPreviewEndReason | null
  queue: Promise<void>
  revision: number
  /** the stream's window has been said to its watchers (the start's answer, or the `live` push of a restart): frames may go */
  announced: boolean
}
export class ComputerPreviews {
  private readonly streams = new Map<string, Stream>()
  private readonly off: (() => void)[] = []
  private next = 0
  private seq = 0
  private closed = false
  constructor(
    private readonly deps: {
      service: ComputerService
      sessions: ComputerSessions
      log?: (line: string) => void
      clock?: Clock
      /** runs a watcher's first frame after its start answer has been sent; default the next macrotask */
      defer?: (fn: () => void) => void
    }
  ) {
    this.off.push(deps.service.onNotification((n) => this.notification(n)))
    this.off.push(
      deps.sessions.onTarget((id) => {
        const s = this.streams.get(id)
        if (s) void this.restart(s)
      })
    )
    this.off.push(
      deps.sessions.onRows((rows) => {
        const live = new Set(rows.map((r) => r.threadId))
        for (const s of this.streams.values())
          if (!live.has(s.threadId)) {
            this.ended(s, 'closed')
            void this.remove(s)
          }
      })
    )
    this.off.push(
      deps.service.onEpoch(() => {
        // (one that ended for want of Screen Recording too: the grant restarts the service, and its watchers are
        // still there, reading the line that told them to turn it on)
        for (const s of this.streams.values()) if (s.stream || s.ended === 'permission') void this.restart(s, true)
      })
    )
  }
  async start(
    viewer: Viewer,
    p: { threadId: string; maxEdge: number }
  ): Promise<ComputerPreviewStart> {
    if (this.closed) throw new Error('Computer previews closed')
    if (
      !Number.isInteger(p.maxEdge) ||
      p.maxEdge < PREVIEW_MIN_EDGE ||
      p.maxEdge > PREVIEW_MAX_EDGE
    )
      throw new Error('Invalid preview size')
    if (!this.deps.sessions.previewTarget(p.threadId))
      throw new Error('No computer window to preview')
    let s = this.streams.get(p.threadId)
    if (!s) {
      s = {
        threadId: p.threadId,
        watchers: new Map(),
        stream: null,
        routed: false,
        edge: 0,
        answer: { app: '', window: null, width: 0, height: 0 },
        ended: null,
        queue: Promise.resolve(),
        revision: 0,
        announced: false,
        gate: new PreviewGate(
          () => this.deps.clock?.now() ?? Date.now(),
          (seq) => {
            if (s!.stream && s!.routed)
              this.deps.service.notify({
                method: 'capture.stream.ack',
                params: { stream: s!.stream, seq }
              })
          }
        )
      }
      this.streams.set(p.threadId, s)
    }
    const id = `preview_${++this.next}`
    const watcher: Watcher = { id, viewer, maxEdge: p.maxEdge, early: [] }
    s.watchers.set(id, watcher)
    s.gate.add(id, (f) => viewer.send({ ...f, preview: id }))
    if (!s.stream || p.maxEdge > s.edge) await this.restart(s)
    // Another start or retarget may have replaced the operation we awaited.
    for (;;) {
      const queued = s.queue
      await queued
      if (queued === s.queue) break
    }
    // Frames go to this watcher only after its answer is on the socket (index.ts sends it once this
    // resolves): a frame naming an id the client has not been told would never be drawn or acked.
    const stream = s
    ;(this.deps.defer ?? ((fn: () => void) => void setTimeout(fn, 0)))(() => {
      // (a restart under way has not said its window yet: its `live` push readies this watcher)
      if (stream.announced) stream.gate.ready(id)
      const early = watcher.early ?? []
      watcher.early = null
      if (stream.watchers.get(id) === watcher) for (const click of early) viewer.send(click)
    })
    return { preview: id, ...s.answer, ...(s.ended ? { ended: s.ended } : {}) }
  }
  ack(connection: object, preview: string, seq: number): void {
    const s = this.find(connection, preview)
    s?.gate.ack(preview, seq)
  }
  async stop(connection: object, preview: string): Promise<void> {
    const s = this.find(connection, preview)
    if (!s) return
    s.watchers.delete(preview)
    s.gate.remove(preview)
    if (!s.watchers.size) await this.remove(s)
    else if (Math.max(...[...s.watchers.values()].map((w) => w.maxEdge)) !== s.edge)
      await this.restart(s)
  }
  dropConnection(connection: object): void {
    for (const s of this.streams.values())
      for (const w of s.watchers.values())
        if (w.viewer.connection === connection) void this.stop(connection, w.id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const off of this.off) off()
    await Promise.all([...this.streams.values()].map((s) => this.remove(s)))
  }
  private find(connection: object, id: string): Stream | undefined {
    return [...this.streams.values()].find(
      (s) => s.watchers.get(id)?.viewer.connection === connection
    )
  }
  private push(s: Stream, p: Omit<ComputerPreviewPush, 'preview' | 'push'>): void {
    for (const w of s.watchers.values())
      w.viewer.send({ push: 'computer-preview', preview: w.id, ...p })
  }
  private ended(s: Stream, reason: ComputerPreviewEndReason): void {
    s.routed = false
    s.ended = reason
    s.gate.reset()
    this.push(s, { state: 'ended', reason })
  }
  private async stopStream(s: Stream): Promise<void> {
    const old = s.stream
    s.stream = null
    if (old)
      await this.deps.service.request('capture.stream.stop', { stream: old }).catch(() => undefined)
  }
  private remove(s: Stream): Promise<void> {
    this.streams.delete(s.threadId)
    s.routed = false
    s.revision++
    s.queue = s.queue.then(() => this.stopStream(s))
    return s.queue
  }
  private restart(s: Stream, epoch = false): Promise<void> {
    s.routed = false
    const revision = ++s.revision
    s.queue = s.queue.then(async () => {
      await this.stopStream(s)
      if (revision !== s.revision || !s.watchers.size || this.streams.get(s.threadId) !== s) return
      s.gate.reset()
      // The watchers already drawing get no frame of the new stream before the push that says whose window it is:
      // the service may send one before its start answers, and it would be drawn under the old window's name.
      s.gate.hold()
      s.announced = false
      try {
        const target = this.deps.sessions.previewTarget(s.threadId)
        if (!target) {
          this.ended(s, 'closed')
          return
        }
        await this.deps.sessions.ensureOpen(s.threadId)
        if (revision !== s.revision || this.streams.get(s.threadId) !== s) return
        const edge = Math.max(...[...s.watchers.values()].map((w) => w.maxEdge))
        s.stream = `pv_${++this.next}`
        s.edge = edge
        s.routed = true
        s.answer = { app: target.app.name, window: target.window.title, target: `${target.app.pid}:${target.window.id}`, width: 0, height: 0 }
        const size = await this.deps.service.request('capture.stream.start', {
          session: target.serviceSession,
          app: { pid: target.app.pid },
          window: { id: target.window.id },
          stream: s.stream,
          fps: 4,
          maxEdge: edge
        })
        if (revision !== s.revision || !s.routed) return
        s.ended = null
        s.answer = { ...s.answer, width: size.width, height: size.height }
        this.push(s, { state: 'live', ...s.answer })
        s.announced = true
        // (a watcher whose start answer is not out yet is readied by its own start)
        for (const w of s.watchers.values()) if (w.early === null) s.gate.ready(w.id)
      } catch (error) {
        if (revision !== s.revision) return
        const kind = error instanceof ComputerRpcError ? error.data?.kind : null
        this.ended(
          s,
          kind === 'window_minimized'
            ? 'minimized'
            : kind === 'permission_missing'
              ? 'permission'
              : epoch
                ? 'restarted'
                : 'error'
        )
        this.deps.log?.(`Computer preview: ${(error as Error).message}`)
        await this.stopStream(s)
      }
    })
    return s.queue
  }
  private notification(n: ComputerNotification): void {
    if (
      n.method !== 'capture/frame' &&
      n.method !== 'capture/click' &&
      n.method !== 'capture/streamEnded'
    )
      return
    const s = [...this.streams.values()].find((s) => s.routed && s.stream === n.params.stream)
    if (!s) {
      if (n.method === 'capture/frame')
        this.deps.service.notify({
          method: 'capture.stream.ack',
          params: { stream: n.params.stream, seq: n.params.seq }
        })
      return
    }
    if (n.method === 'capture/frame') {
      const { width, height, data, seq } = n.params
      s.gate.frame(
        { push: 'computer-frame', preview: '', seq: ++this.seq, width, height, data },
        seq
      )
    } else if (n.method === 'capture/click') {
      for (const w of s.watchers.values()) {
        const click: ComputerClickPush = { push: 'computer-click', preview: w.id, at: n.params.at, width: n.params.width, height: n.params.height }
        if (w.early) w.early.push(click)
        else w.viewer.send(click)
      }
    } else {
      this.ended(
        s,
        n.params.reason === 'window-closed'
          ? 'window-closed'
          : n.params.reason === 'permission'
            ? 'permission'
            : 'error'
      )
      s.queue = s.queue.then(() => this.stopStream(s))
    }
  }
}

export async function handleComputerPreview(
  req: ClientRequest,
  previews: ComputerPreviews | null,
  viewer: Viewer
): Promise<{ handled: boolean; result?: unknown }> {
  if (!req.method.startsWith('computer.preview.')) return { handled: false }
  if (!previews) throw new Error('Computer use is not available here')
  switch (req.method) {
    case 'computer.preview.start':
      return { handled: true, result: await previews.start(viewer, req.params) }
    case 'computer.preview.ack':
      previews.ack(viewer.connection, req.params.preview, req.params.seq)
      break
    case 'computer.preview.stop':
      await previews.stop(viewer.connection, req.params.preview)
      break
  }
  return { handled: true, result: null }
}
