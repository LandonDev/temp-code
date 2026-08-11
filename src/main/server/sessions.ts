import { nanoid } from 'nanoid'
import type { CreateSessionParams } from '@shared/contract'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { BUILT_IN_DRIVERS } from './drivers'
import type { DriverHandle } from './drivers/types'
import type { Store } from './db'

type SessionListener = (row: EventRow) => void
type MetaListener = (session: SessionMeta) => void

/**
 * The session registry: owns the session tree, the append-only event log,
 * live driver handles, and per-session subscriptions. The single write
 * path — everything user-visible flows through append().
 */
export class SessionRegistry {
  private handles = new Map<string, DriverHandle>()
  private starting = new Map<string, Promise<DriverHandle>>()
  private subscribers = new Map<string, Set<SessionListener>>()
  private metaListeners = new Set<MetaListener>()

  constructor(private store: Store) {}

  list(): SessionMeta[] {
    return this.store.listSessions()
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.store.eventsAfter(sessionId, afterSeq)
  }

  async create(params: CreateSessionParams): Promise<SessionMeta> {
    const now = Date.now()
    const meta: SessionMeta = {
      id: nanoid(12),
      parentId: params.parentId,
      provider: params.provider,
      model: params.model,
      reasoning: params.reasoning,
      agentType: params.agentType,
      title: params.title ?? `${params.provider} · ${params.agentType}`,
      cwd: params.cwd,
      status: 'starting',
      nativeId: null,
      createdAt: now,
      updatedAt: now
    }
    this.store.insertSession(meta)
    this.notifyMeta(meta)
    if (params.parentId) {
      this.append(params.parentId, { type: 'agent-spawned', childSessionId: meta.id })
    }
    // Start the harness eagerly so status/errors surface immediately.
    void this.handleFor(meta.id).catch(() => {})
    return meta
  }

  async send(sessionId: string, text: string): Promise<void> {
    const handle = await this.handleFor(sessionId)
    await handle.send(text)
  }

  async interrupt(sessionId: string): Promise<void> {
    this.handles.get(sessionId)?.interrupt()
  }

  private async handleFor(sessionId: string): Promise<DriverHandle> {
    const existing = this.handles.get(sessionId)
    if (existing) return existing
    const inflight = this.starting.get(sessionId)
    if (inflight) return inflight

    const meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    const driver = BUILT_IN_DRIVERS[meta.provider]

    const startP = driver
      .start({
        session: meta,
        emit: (event) => this.append(sessionId, event),
        setNativeId: (nativeId) => {
          const next = this.store.updateSession(sessionId, { nativeId })
          if (next) this.notifyMeta(next)
        }
      })
      .then((handle) => {
        this.handles.set(sessionId, handle)
        this.starting.delete(sessionId)
        return handle
      })
      .catch((err) => {
        this.starting.delete(sessionId)
        this.append(sessionId, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
        this.append(sessionId, { type: 'status', status: 'error' })
        throw err
      })
    this.starting.set(sessionId, startP)
    return startP
  }

  append(sessionId: string, event: AgentEvent): void {
    const row = this.store.appendEvent(sessionId, event)
    // Status events also update the session row (drives the sidebar).
    if (event.type === 'status') {
      const next = this.store.updateSession(sessionId, { status: event.status })
      if (next) this.notifyMeta(next)
    }
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  onMeta(listener: MetaListener): () => void {
    this.metaListeners.add(listener)
    return () => this.metaListeners.delete(listener)
  }

  private notifyMeta(session: SessionMeta): void {
    for (const l of this.metaListeners) l(session)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }
}
