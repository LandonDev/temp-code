import { nanoid } from 'nanoid'
import { basename } from 'node:path'
import { CreateSessionParams, type CreateSessionInput } from '@shared/contract'
import type { AgentEvent, Attachment, EventRow, SessionMeta } from '@shared/events'
import type { ProjectMeta, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { BUILT_IN_DRIVERS } from './drivers'
import type { DriverHandle } from './drivers/types'
import type { Store } from './db'
import { addProjectWorktree, currentBranch, ensureLocalExclude, isGitRepo } from './git'
import { planPathFor, planSeed, threadPreamble } from './threads'

const THREAD_TITLES = {
  chat: 'New chat',
  planning: 'New plan',
  implementation: 'New task',
  orchestration: 'New orchestration'
} as const

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

  // ── workspaces & projects ──────────────────────────────────────────

  async createWorkspace(path: string, name?: string): Promise<WorkspaceMeta> {
    const existing = this.store.listWorkspaces().find((w) => w.path === path)
    if (existing) return existing
    const meta: WorkspaceMeta = {
      id: nanoid(12),
      name: name ?? basename(path),
      path,
      git: await isGitRepo(path),
      createdAt: Date.now()
    }
    this.store.insertWorkspace(meta)
    return meta
  }

  listWorkspaces(): WorkspaceMeta[] {
    return this.store.listWorkspaces()
  }

  /** Removes the workspace, its projects, and their threads (worktrees stay on disk). */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const projectIds = this.store.deleteWorkspace(workspaceId)
    for (const pid of projectIds) await this.deleteProjectSessions(pid)
  }

  async createProject(workspaceId: string, name: string, mode: ProjectMode): Promise<ProjectMeta> {
    const ws = this.store.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) throw new Error(`unknown workspace: ${workspaceId}`)
    let cwd = ws.path
    let branch: string | null = null
    if (mode === 'worktree') {
      if (!ws.git) throw new Error('worktree projects need a git workspace')
      const wt = await addProjectWorktree(ws.path, name)
      cwd = wt.cwd
      branch = wt.branch
    } else {
      branch = await currentBranch(ws.path)
    }
    const meta: ProjectMeta = {
      id: nanoid(12),
      workspaceId,
      name,
      mode,
      branch,
      cwd,
      createdAt: Date.now()
    }
    this.store.insertProject(meta)
    void ensureLocalExclude(cwd) // plan docs (.temp-code/) stay out of git
    return meta
  }

  listProjects(): ProjectMeta[] {
    return this.store.listProjects()
  }

  getProject(projectId: string): ProjectMeta | null {
    return this.store.getProject(projectId)
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.deleteProjectSessions(projectId)
    this.store.deleteProject(projectId)
  }

  private async deleteProjectSessions(projectId: string): Promise<void> {
    for (const s of this.store.sessionsOfProject(projectId)) {
      if (!s.parentId) await this.delete(s.id) // roots cascade to children
    }
  }

  eventsAfter(sessionId: string, afterSeq: number): EventRow[] {
    return this.store.eventsAfter(sessionId, afterSeq)
  }

  async create(raw: CreateSessionInput): Promise<SessionMeta> {
    const params = CreateSessionParams.parse(raw)
    const now = Date.now()
    const id = nanoid(12)
    const project = params.projectId ? this.store.getProject(params.projectId) : null
    const cwd = project?.cwd ?? params.cwd
    if (!cwd) throw new Error('session needs a cwd or a projectId')
    const meta: SessionMeta = {
      id,
      parentId: params.parentId,
      projectId: params.projectId,
      threadType: params.threadType,
      // Planning threads own a plan file; seeded threads point at their source.
      planPath: params.threadType === 'planning' ? planPathFor(cwd, id) : (params.planPath ?? null),
      provider: params.provider,
      model: params.model,
      reasoning: params.reasoning,
      // Orchestration threads ARE orchestrator sessions (MCP toolset attaches).
      agentType: params.threadType === 'orchestration' ? 'orchestrator' : params.agentType,
      title:
        params.title ??
        (params.threadType
          ? THREAD_TITLES[params.threadType]
          : `${params.provider} · ${params.agentType}`),
      cwd,
      // The harness boots lazily on first send; a new session is simply
      // ready for input.
      status: 'idle',
      archived: false,
      permission: params.permission,
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

  async send(
    sessionId: string,
    text: string,
    opts?: {
      model?: string
      reasoning?: SessionMeta['reasoning']
      attachments?: Attachment[]
    }
  ): Promise<void> {
    let meta = this.store.getSession(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    // Zeron unarchive-on-send: a message into an archived thread revives it.
    if (meta.archived) {
      const next = this.store.updateSession(sessionId, { archived: false })
      if (next) {
        meta = next
        this.notifyMeta(next)
      }
    }
    // Per-message model/reasoning: persist the change and drop the live
    // handle — the next handleFor() boots the harness fresh (resume keeps
    // the conversation) with the new settings.
    const model = opts?.model ?? meta.model
    const reasoning = opts?.reasoning ?? meta.reasoning
    if (model !== meta.model || reasoning !== meta.reasoning) {
      await this.dropHandle(sessionId)
      const next = this.store.updateSession(sessionId, { model, reasoning })
      if (next) {
        meta = next
        this.notifyMeta(next)
      }
    }
    const handle = await this.handleFor(sessionId)
    this.lastActivity.set(sessionId, Date.now())
    // The visible transcript carries only what the user typed; thread-type
    // preambles ride along on the first message, provider-agnostic.
    const first = !this.store.hasUserText(sessionId)
    const attachments = opts?.attachments?.length ? opts.attachments : undefined
    this.append(sessionId, { type: 'user-text', text, attachments })
    // Cursor-style: an untitled thread takes its name from the first message.
    if (first && (Object.values(THREAD_TITLES) as string[]).includes(meta.title)) {
      const title = text.trim().split('\n')[0].slice(0, 60)
      if (title) {
        const next = this.store.updateSession(sessionId, { title })
        if (next) this.notifyMeta(next)
      }
    }
    let out = text
    if (first) {
      const parts = [threadPreamble(meta)]
      if (meta.threadType !== 'planning' && meta.planPath) parts.push(planSeed(meta.planPath))
      const preamble = parts.filter(Boolean).join('\n\n')
      if (preamble) out = `<thread-instructions>\n${preamble}\n</thread-instructions>\n\n${text}`
    }
    await handle.send(out, attachments)
  }

  async interrupt(sessionId: string): Promise<void> {
    this.handles.get(sessionId)?.interrupt()
  }

  async approve(sessionId: string, requestId: string, allow: boolean): Promise<void> {
    this.handles.get(sessionId)?.approve?.(requestId, allow)
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

  /** Change approval policy; the harness restarts (with resume) on next send. */
  async setPermission(sessionId: string, permission: SessionMeta['permission']): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, { permission })
    if (next) this.notifyMeta(next)
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
    // Streaming previews (partial tool input) are broadcast-only: each one
    // carries the whole input so far, so persisting them would write the
    // same growing payload into the log over and over. The final tool-call
    // event has everything replay needs.
    if (event.type === 'tool-call' && event.partial) {
      const row: EventRow = { sessionId, seq: -1, ts: Date.now(), event, ephemeral: true }
      for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
      return
    }
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
