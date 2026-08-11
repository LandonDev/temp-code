import { nanoid } from 'nanoid'
import type { CreateSessionParams } from '@shared/contract'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { BUILT_IN_DRIVERS } from './drivers'
import type { DriverHandle } from './drivers/types'
import type { Store } from './db'

type SessionListener = (row: EventRow) => void
type MetaListener = (session: SessionMeta) => void
type RemovedListener = (sessionIds: string[]) => void

/** Dispose idle harness handles after this long; resume restores them. */
const IDLE_DISPOSE_MS = 10 * 60 * 1000

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
  private removedListeners = new Set<RemovedListener>()
  private lastActivity = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private store: Store) {}

  /**
   * Idle disposal — what keeps dozens of sessions cheap. A handle whose
   * session has sat idle past the threshold is dropped; the session stays
   * listed and the next send lazily restarts the harness via resume.
   */
  startIdleSweep(idleMs = IDLE_DISPOSE_MS): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, handle] of this.handles) {
        const meta = this.store.getSession(id)
        const last = this.lastActivity.get(id) ?? 0
        if (meta?.status === 'idle' && now - last > idleMs) {
          this.handles.delete(id)
          void handle.dispose().catch(() => {})
        }
      }
    }, 60_000)
  }

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
      // The harness boots lazily on first send; a new session is simply
      // ready for input.
      status: 'idle',
      archived: false,
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
    this.lastActivity.set(sessionId, Date.now())
    await handle.send(text)
  }

  async interrupt(sessionId: string): Promise<void> {
    this.handles.get(sessionId)?.interrupt()
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (archived) await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, { archived })
    if (next) this.notifyMeta(next)
  }

  async delete(sessionId: string): Promise<void> {
    const ids = this.store.deleteSessionTree(sessionId)
    for (const id of ids) {
      await this.dropHandle(id)
      this.subscribers.delete(id)
      this.lastActivity.delete(id)
    }
    for (const l of this.removedListeners) l(ids)
  }

  async restart(sessionId: string): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, { status: 'idle' })
    if (next) this.notifyMeta(next)
  }

  private async dropHandle(sessionId: string): Promise<void> {
    const inflight = this.starting.get(sessionId)
    if (inflight) await inflight.catch(() => {})
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    this.starting.delete(sessionId)
    if (handle) await handle.dispose().catch(() => {})
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
    this.lastActivity.set(sessionId, row.ts)
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

  onRemoved(listener: RemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
  }

  private notifyMeta(session: SessionMeta): void {
    for (const l of this.metaListeners) l(session)
  }

  async disposeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }
}
