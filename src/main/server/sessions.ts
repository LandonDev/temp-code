import { nanoid } from 'nanoid'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { CreateSessionParams, type CreateSessionInput } from '@shared/contract'
import { CATALOG, resolveModel, type ProviderId } from '@shared/catalog'
import type { AgentEvent, Attachment, EventRow, SessionMeta } from '@shared/events'
import type { ProjectMeta, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { BUILT_IN_DRIVERS } from './drivers'
import type { DriverHandle } from './drivers/types'
import type { Store } from './db'
import { addProjectWorktree, currentBranch, ensureLocalExclude, isGitRepo } from './git'
import { parseRules, type OrchestrationRules } from '@shared/rules'
import { DEFAULT_THREAD_DEFAULTS, parseDefaults, type ThreadDefaults } from '@shared/defaults'
import {
  AppshotSettingsSchema,
  DEFAULT_APPSHOT_SETTINGS,
  type AppshotSettings
} from '@shared/appshots'
import { planPathFor, planSeed, projectContext, threadPreamble } from './threads'
import { notifyParentOfSettle } from './orchestration'
import { liveDiffOnStatus } from './livediff'
import {
  appendJournal,
  INLINE_DIGEST_MAX_CHARS,
  removeMirror,
  scheduleMirror,
  seedJournal,
  threadDigest,
  writeThreadDigest
} from './mirror'

const THREAD_TITLES = {
  chat: 'New chat',
  planning: 'New plan',
  implementation: 'New task',
  orchestration: 'New orchestration'
} as const

type SessionListener = (row: EventRow) => void
type MetaListener = (session: SessionMeta) => void

/** Cap for the transcript handoff sent to a new harness on provider switch. */
const HANDOFF_MAX_CHARS = 24_000

/**
 * Serialize the dialogue for a cross-provider switch: the new harness has no
 * native session to resume, so the conversation replays as context. Text
 * only — thinking and tool internals stay with the old harness.
 */
function transcriptHandoff(rows: EventRow[]): string {
  const turns: { role: 'User' | 'Assistant'; text: string }[] = []
  for (const { event } of rows) {
    let role: 'User' | 'Assistant'
    if (event.type === 'user-text') role = 'User'
    else if (event.type === 'assistant-text' && !event.delta && !event.parentCallId) {
      role = 'Assistant'
    } else continue
    const last = turns.at(-1)
    if (last?.role === role) last.text += `\n${event.text}`
    else turns.push({ role, text: event.text })
  }
  if (turns.length === 0) return ''
  let body = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n')
  if (body.length > HANDOFF_MAX_CHARS) {
    body = `[earlier conversation trimmed]\n\n…${body.slice(-HANDOFF_MAX_CHARS)}`
  }
  return `<conversation-handoff>\nYou are taking over an ongoing conversation from another assistant. The transcript so far:\n\n${body}\n\nContinue seamlessly — do not re-introduce yourself or revisit settled questions.\n</conversation-handoff>`
}
type RemovedListener = (sessionIds: string[]) => void
type QueueListener = (sessionId: string, items: QueuedMessage[]) => void

/** Options a queued message carries to its eventual send. */
interface QueuedSendOpts {
  provider?: ProviderId
  model?: string
  reasoning?: SessionMeta['reasoning']
  attachments?: Attachment[]
}

export interface QueuedMessage extends QueuedSendOpts {
  id: string
  text: string
  ts: number
}

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
  /** Per-session message queue: composed mid-turn, drained on idle. */
  private queues = new Map<string, QueuedMessage[]>()
  private queueListeners = new Set<QueueListener>()
  private draining = new Set<string>()
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

  /** At boot no harness handles exist, so a session persisted as running,
   *  waiting, or starting is stale from a previous process — reset it, or
   *  the sidebar and working strip show work that isn't happening (and
   *  can't be stopped). The dead process also never wrote its closing
   *  status event, so refolds would see a forever-open turn: append the
   *  synthetic idle directly (none of append()'s live-session side effects
   *  — queue drain, parent supervision — belong at boot). */
  resetStaleStatuses(): void {
    for (const s of this.store.listSessions()) {
      if (s.status === 'running' || s.status === 'waiting' || s.status === 'starting') {
        this.store.appendEvent(s.id, { type: 'status', status: 'idle' })
        this.store.updateSession(s.id, { status: 'idle', busySince: null })
      }
    }
  }

  list(): SessionMeta[] {
    return this.store.listSessions()
  }

  /** When the session last produced or received anything (drives
   *  idleForSeconds in the orchestrator's supervision tools). */
  lastActivityAt(sessionId: string): number {
    return this.lastActivity.get(sessionId) ?? this.store.getSession(sessionId)?.updatedAt ?? 0
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
    for (const s of this.store.sessionsOfWorkspace(workspaceId)) {
      if (!s.parentId) await this.delete(s.id) // one-off chats; roots cascade
    }
    const projectIds = this.store.deleteWorkspace(workspaceId)
    for (const pid of projectIds) await this.deleteProjectSessions(pid)
  }

  async createProject(
    workspaceId: string,
    name: string,
    mode: ProjectMode,
    opts: { baseRef?: string; existingBranch?: string } = {}
  ): Promise<ProjectMeta> {
    const ws = this.store.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) throw new Error(`unknown workspace: ${workspaceId}`)
    let cwd = ws.path
    let branch: string | null = null
    if (mode === 'worktree') {
      if (!ws.git) throw new Error('worktree projects need a git workspace')
      const wt = await addProjectWorktree(ws.path, name, opts)
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
    seedJournal(meta) // PROJECT.md — the shared journal threads append to
    return meta
  }

  listProjects(): ProjectMeta[] {
    return this.store.listProjects()
  }

  getProject(projectId: string): ProjectMeta | null {
    return this.store.getProject(projectId)
  }

  renameProject(projectId: string, name: string): void {
    const t = name.trim()
    if (t) this.store.renameProject(projectId, t)
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

  // ── orchestration rules & thread defaults (global + workspace) ─────

  /** Structured orchestration rules for a scope; null = not set there
   *  (global falls back to defaults at the call site, a workspace to
   *  the global rules). */
  getOrchestrationRules(workspaceId: string | null): OrchestrationRules | null {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    return parseRules(this.store.getSetting(key))
  }

  /** null clears: global reverts to defaults, an override goes away.
   *  Applies to orchestrators started after the change (resume keeps
   *  running ones on the old prompt until they idle out). */
  setOrchestrationRules(workspaceId: string | null, rules: OrchestrationRules | null): void {
    const key = workspaceId ? `orchestration-rules:${workspaceId}` : 'orchestration-rules'
    this.store.setSetting(key, rules ? JSON.stringify(rules) : null)
  }

  /** Thread defaults for a scope; null = not set there. */
  getThreadDefaults(workspaceId: string | null): ThreadDefaults | null {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    return parseDefaults(this.store.getSetting(key))
  }

  setThreadDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): void {
    const key = workspaceId ? `thread-defaults:${workspaceId}` : 'thread-defaults'
    this.store.setSetting(key, defaults ? JSON.stringify(defaults) : null)
  }

  /** Appshot capture settings — global, defaults until the user changes them. */
  getAppshotSettings(): AppshotSettings {
    const raw = this.store.getSetting('appshots')
    if (raw) {
      const parsed = AppshotSettingsSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    }
    return DEFAULT_APPSHOT_SETTINGS
  }

  setAppshotSettings(settings: AppshotSettings): void {
    this.store.setSetting('appshots', JSON.stringify(settings))
  }

  /** Whether the one first-boot permission prompt has already fired (ever). */
  getAppshotPrompted(): boolean {
    return this.store.getSetting('appshots-prompted') !== null
  }

  markAppshotPrompted(): void {
    this.store.setSetting('appshots-prompted', '1')
  }

  /** What a new thread starts with here: workspace override → global → built-in. */
  resolveThreadDefaults(workspaceId: string | null): ThreadDefaults {
    return (
      (workspaceId ? this.getThreadDefaults(workspaceId) : null) ??
      this.getThreadDefaults(null) ??
      DEFAULT_THREAD_DEFAULTS
    )
  }

  async create(raw: CreateSessionInput): Promise<SessionMeta> {
    const params = CreateSessionParams.parse(raw)
    const now = Date.now()
    const id = nanoid(12)
    const project = params.projectId ? this.store.getProject(params.projectId) : null
    // One-off chats: a workspace chat runs at the workspace root, a fully
    // loose chat in the home directory.
    const workspace =
      !project && params.workspaceId
        ? this.store.listWorkspaces().find((w) => w.id === params.workspaceId)
        : null
    if (!project && params.workspaceId && !workspace) {
      throw new Error(`unknown workspace: ${params.workspaceId}`)
    }
    const cwd = project?.cwd ?? workspace?.path ?? params.cwd ?? homedir()
    // Fields the caller left open come from the thread defaults
    // (workspace override → global → built-in).
    const d = this.resolveThreadDefaults(project?.workspaceId ?? workspace?.id ?? null)
    // A model id names its harness: a session asked to run another
    // provider's model routes to that provider instead of erroring.
    const requested = params.provider ?? d.provider
    const { provider, model } = resolveModel(
      requested,
      params.model ?? (d.model || CATALOG[requested].defaultModel)
    )
    const meta: SessionMeta = {
      id,
      parentId: params.parentId,
      projectId: params.projectId,
      workspaceId: workspace?.id ?? null,
      threadType: params.threadType,
      // Planning threads own a plan file; seeded threads point at their source.
      planPath: params.threadType === 'planning' ? planPathFor(cwd, id) : (params.planPath ?? null),
      provider,
      model,
      reasoning: params.reasoning ?? d.reasoning,
      // Orchestration threads ARE orchestrator sessions (MCP toolset attaches).
      agentType: params.threadType === 'orchestration' ? 'orchestrator' : params.agentType,
      title:
        params.title ??
        (params.threadType
          ? THREAD_TITLES[params.threadType]
          : `${provider} · ${params.agentType}`),
      cwd,
      // The harness boots lazily on first send; a new session is simply
      // ready for input.
      status: 'idle',
      archived: false,
      permission: params.permission ?? d.permission,
      fast: false,
      context1m: false,
      busySince: null,
      nativeId: null,
      createdAt: now,
      updatedAt: now
    }
    this.store.insertSession(meta)
    this.notifyMeta(meta)
    if (params.parentId) {
      this.append(params.parentId, { type: 'agent-spawned', childSessionId: meta.id })
    }
    // A build starting from a plan auto-archives its planning thread: the
    // conversation is over, the plan file carries the context. Archiving
    // touches nothing the models use — mirrors and the plan doc stay, and
    // any send into the thread revives it.
    if (
      meta.planPath &&
      (meta.threadType === 'implementation' || meta.threadType === 'orchestration')
    ) {
      const planThread = this.store
        .listSessions()
        .find((s) => s.threadType === 'planning' && s.planPath === meta.planPath && !s.archived)
      if (planThread) void this.setArchived(planThread.id, true)
    }
    // Start the harness eagerly so status/errors surface immediately.
    void this.handleFor(meta.id).catch(() => {})
    return meta
  }

  async send(
    sessionId: string,
    text: string,
    opts?: {
      provider?: ProviderId
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
    // A model id names its harness (resolveModel): a message asking this
    // thread for another provider's model switches the thread to that
    // provider rather than handing the harness a model it will reject.
    const routed = opts?.model
      ? resolveModel(opts?.provider ?? meta.provider, opts.model)
      : { provider: opts?.provider ?? meta.provider, model: undefined }
    const provider = routed.provider
    const reasoning = opts?.reasoning ?? meta.reasoning
    let handoff = ''
    if (provider !== meta.provider) {
      // Cross-harness switch: native resume can't follow, so the next
      // harness starts a fresh native session seeded with the transcript.
      handoff = transcriptHandoff(this.store.eventsAfter(sessionId, 0))
      await this.dropHandle(sessionId)
      const next = this.store.updateSession(sessionId, {
        provider,
        model: routed.model ?? CATALOG[provider].defaultModel,
        reasoning,
        nativeId: null
      })
      if (next) {
        meta = next
        this.notifyMeta(next)
      }
    } else {
      // Per-message model/reasoning: persist the change and drop the live
      // handle — the next handleFor() boots the harness fresh (resume keeps
      // the conversation) with the new settings.
      const model = routed.model ?? meta.model
      if (model !== meta.model || reasoning !== meta.reasoning) {
        await this.dropHandle(sessionId)
        const next = this.store.updateSession(sessionId, { model, reasoning })
        if (next) {
          meta = next
          this.notifyMeta(next)
        }
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
      // Shared context (M8): root project threads open knowing the project —
      // the journal, the sibling transcripts, the journal-append contract.
      if (!meta.parentId && meta.projectId) {
        const project = this.store.getProject(meta.projectId)
        if (project) {
          const ws = this.store.listWorkspaces().find((w) => w.id === project.workspaceId)
          const ctx = projectContext(
            meta,
            project,
            ws?.name ?? null,
            this.store.sessionsOfProject(meta.projectId)
          )
          out = `${ctx}\n\n${out}`
        }
      }
    }
    if (handoff) out = `${handoff}\n\n${out}`
    // Thread references (M9): each referenced thread becomes a fresh local
    // digest file; the @thread:<id> token is rewritten to its path (every
    // harness follows @path). Projectless sessions get the digest inline.
    for (const ref of attachments?.filter((a) => a.kind === 'thread' && a.sessionId) ?? []) {
      const refMeta = this.store.getSession(ref.sessionId!)
      if (!refMeta) continue
      const refProject = refMeta.projectId ? this.store.getProject(refMeta.projectId) : null
      const token = `@thread:${refMeta.id}`
      const here = meta.projectId ? this.store.getProject(meta.projectId) : null
      if (here) {
        const rel = writeThreadDigest(this, refMeta, here.cwd)
        const mention = `@${rel} (thread "${refMeta.title}"${refProject ? ` from project "${refProject.name}"` : ''})`
        out = out.includes(token) ? out.replaceAll(token, mention) : `${out}\n\n${mention}`
      } else {
        let digest = threadDigest(this, refMeta)
        if (digest.length > INLINE_DIGEST_MAX_CHARS) {
          digest = `_[earlier turns trimmed]_\n\n…${digest.slice(-INLINE_DIGEST_MAX_CHARS)}`
        }
        const mention = `thread "${refMeta.title}" (referenced below)`
        if (out.includes(token)) out = out.replaceAll(token, mention)
        out = `${out}\n\n<thread-reference title=${JSON.stringify(refMeta.title)}>\n${digest}\n</thread-reference>`
      }
    }
    // Thread references are resolved above; appshots expand into the plain
    // image + text-file pair every harness understands (the persisted event
    // keeps the appshot itself, so the transcript renders the chip).
    const sendAttachments = attachments
      ?.filter((a) => a.kind !== 'thread')
      .flatMap((a) => {
        if (a.kind !== 'appshot') return [a]
        const shot: Attachment = {
          path: a.path,
          name: a.name,
          mime: a.mime ?? 'image/jpeg',
          kind: 'image'
        }
        return a.textPath
          ? [shot, { path: a.textPath, name: `${a.name} (window text)`, kind: 'file' as const }]
          : [shot]
      })
    try {
      await handle.send(out, sendAttachments)
    } catch (err) {
      // A steer at a provider that can't take mid-turn input (cursor's
      // process-per-turn) front-queues instead of erroring the composer.
      if (err instanceof Error && err.message.includes('still running')) {
        this.queueAdd(sessionId, text, opts, true)
        return
      }
      // The handle's harness is gone (watchdog recovery, stream death) —
      // boot a fresh one and deliver there; resume keeps the conversation.
      if (err instanceof Error && err.message.includes('harness gone')) {
        await this.dropHandle(sessionId)
        const fresh = await this.handleFor(sessionId)
        await fresh.send(out, sendAttachments)
        return
      }
      throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (handle) {
      handle.interrupt()
      return
    }
    // No live harness (crashed, disposed, or the app restarted) — nothing is
    // actually running, whatever the persisted status says. Stop must still
    // work: clear the stale status so the UI settles.
    const meta = this.store.getSession(sessionId)
    if (meta && meta.status !== 'idle' && meta.status !== 'error') {
      this.append(sessionId, { type: 'status', status: 'idle' })
    }
  }

  async approve(sessionId: string, requestId: string, allow: boolean): Promise<void> {
    if (this.handles.get(sessionId)?.approve?.(requestId, allow)) return
    // Stale request: asked by a previous process of this harness, whose
    // resolver died with it. Settle the card so it can't wedge the UI —
    // the tool call it guarded is gone either way.
    if (this.unresolvedRequest(sessionId, requestId, 'approval')) {
      this.append(sessionId, { type: 'approval-resolved', requestId, allow })
    }
  }

  async answer(sessionId: string, requestId: string, answers: string[][] | null): Promise<void> {
    if (this.handles.get(sessionId)?.answer?.(requestId, answers)) return
    // Stale request: settle the card, then deliver the answers as an
    // ordinary message so the model still receives the decisions.
    const req = this.unresolvedRequest(sessionId, requestId, 'question')
    if (!req || req.type !== 'question-request') return
    this.append(sessionId, { type: 'question-resolved', requestId, answers })
    if (answers?.some((a) => a.length)) {
      const lines = req.questions
        .map((q, i) => (answers[i]?.length ? `- ${q.question} → ${answers[i].join(', ')}` : null))
        .filter(Boolean)
      await this.send(sessionId, `Answers to your earlier questions:\n${lines.join('\n')}`)
    }
  }

  /** The still-unresolved question/approval request for an id, if any. */
  private unresolvedRequest(
    sessionId: string,
    requestId: string,
    kind: 'question' | 'approval'
  ): Extract<AgentEvent, { type: 'question-request' | 'approval-request' }> | null {
    const rows = this.store.eventsAfter(sessionId, 0)
    const resolved = kind === 'question' ? 'question-resolved' : 'approval-resolved'
    if (rows.some((r) => r.event.type === resolved && r.event.requestId === requestId)) return null
    const reqType = kind === 'question' ? 'question-request' : 'approval-request'
    const req = rows.find(
      (r) => r.event.type === reqType && (r.event as { requestId?: string }).requestId === requestId
    )
    return req
      ? (req.event as Extract<AgentEvent, { type: 'question-request' | 'approval-request' }>)
      : null
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const t = title.trim().slice(0, 120)
    if (!t) return
    const next = this.store.updateSession(sessionId, { title: t })
    if (next) this.notifyMeta(next)
  }

  /** Fast mode / context window: persist and drop the handle — the next
   *  send boots the harness fresh (resume keeps the conversation). */
  async tune(sessionId: string, patch: { fast?: boolean; context1m?: boolean }): Promise<void> {
    await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, patch)
    if (next) this.notifyMeta(next)
  }

  /** Live context usage from the session's harness, if it can report it. */
  async contextUsage(sessionId: string): Promise<unknown> {
    // Never poke a streaming harness. Mid-turn control requests can't be
    // answered until the turn settles, and a queue of them at result time
    // can cost the stream its result message — wedging the thread on
    // "working" forever.
    const status = this.store.getSession(sessionId)?.status
    if (status === 'running' || status === 'starting') return null
    const handle = this.handles.get(sessionId)
    if (!handle?.contextUsage) return null
    try {
      return await handle.contextUsage()
    } catch {
      return null
    }
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (archived) await this.dropHandle(sessionId)
    const next = this.store.updateSession(sessionId, { archived })
    if (next) this.notifyMeta(next)
  }

  async delete(sessionId: string): Promise<void> {
    this.queues.delete(sessionId)
    const all = this.store.listSessions()
    const root = all.find((s) => s.id === sessionId)
    const ids = this.store.deleteSessionTree(sessionId)
    for (const id of ids) {
      await this.dropHandle(id)
      this.subscribers.delete(id)
      this.lastActivity.delete(id)
      const meta = all.find((s) => s.id === id)
      if (meta) removeMirror(this, meta) // mirrors die with the thread
    }
    // The journal never dangles into a missing plan file.
    if (root?.threadType === 'planning' && root.projectId) {
      const cwd = this.store.getProject(root.projectId)?.cwd
      if (cwd) await appendJournal(cwd, `plan "${root.title}" thread deleted`)
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
    const next = this.store.updateSession(sessionId, { status: 'idle', busySince: null })
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
    let settleToReport: SessionMeta | null = null
    // Status events also update the session row (drives the sidebar).
    // busySince anchors the "working for" timers: it is set when a stretch
    // of work begins and holds through steers and queue drains, so the
    // clock counts from the first message, not the latest wake-up.
    if (event.type === 'status') {
      const cur = this.store.getSession(sessionId)
      const busySince =
        event.status === 'idle'
          ? (this.queues.get(sessionId)?.length ?? 0) > 0
            ? (cur?.busySince ?? null)
            : null
          : (cur?.busySince ?? row.ts)
      const next = this.store.updateSession(sessionId, { status: event.status, busySince })
      if (next) this.notifyMeta(next)
      // Live change stream (M22): watchers follow running sessions.
      if (next) liveDiffOnStatus(this, next, cur?.status)
      // A settled turn releases the next queued message.
      if (event.status === 'idle') this.drainQueue(sessionId)
      // Dormant supervision: a subagent leaving "running" wakes its parent
      // with an automatic report — immediately when the parent is idle,
      // queued behind its current work otherwise. Skipped when a
      // wait_for_agent already covers this child.
      if (
        next?.parentId &&
        cur?.status === 'running' &&
        (event.status === 'idle' || event.status === 'error' || event.status === 'waiting')
      ) {
        settleToReport = next
      }
    }
    // Shared context (M8): a finished turn refreshes the thread's mirror.
    if (event.type === 'turn-complete' && this.store.getSession(sessionId)?.projectId) {
      scheduleMirror(this, sessionId)
    }
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(row)
    if (settleToReport) notifyParentOfSettle(this, settleToReport)
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

  // ── message queue (queueing + steering) ────────────────────────────

  onQueue(listener: QueueListener): () => void {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  queueList(sessionId: string): QueuedMessage[] {
    return this.queues.get(sessionId) ?? []
  }

  private notifyQueue(sessionId: string): void {
    const items = this.queueList(sessionId)
    for (const l of this.queueListeners) l(sessionId, items)
  }

  queueAdd(sessionId: string, text: string, opts?: QueuedSendOpts, front = false): QueuedMessage {
    const item: QueuedMessage = { id: nanoid(10), text, ts: Date.now(), ...opts }
    const q = this.queues.get(sessionId) ?? []
    if (front) q.unshift(item)
    else q.push(item)
    this.queues.set(sessionId, q)
    this.notifyQueue(sessionId)
    // The turn may have settled while the user was typing.
    if (this.store.getSession(sessionId)?.status === 'idle') this.drainQueue(sessionId)
    return item
  }

  queueRemove(sessionId: string, messageId: string): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    this.queues.set(
      sessionId,
      q.filter((m) => m.id !== messageId)
    )
    this.notifyQueue(sessionId)
  }

  queueUpdate(sessionId: string, messageId: string, text: string): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    this.queues.set(
      sessionId,
      q.map((m) => (m.id === messageId ? { ...m, text } : m))
    )
    this.notifyQueue(sessionId)
  }

  queueReorder(sessionId: string, order: string[]): void {
    const q = this.queues.get(sessionId)
    if (!q) return
    const byId = new Map(q.map((m) => [m.id, m]))
    const next = order.flatMap((id) => byId.get(id) ?? [])
    for (const m of q) if (!order.includes(m.id)) next.push(m)
    this.queues.set(sessionId, next)
    this.notifyQueue(sessionId)
  }

  /** Send a queued message NOW. Claude injects into the live turn; a
   *  provider that can't steer throws mid-turn, and the message falls
   *  back to the FRONT of the queue (sends next). */
  async queueSteer(sessionId: string, messageId: string): Promise<void> {
    const q = this.queues.get(sessionId) ?? []
    const item = q.find((m) => m.id === messageId)
    if (!item) return
    this.queues.set(
      sessionId,
      q.filter((m) => m.id !== messageId)
    )
    this.notifyQueue(sessionId)
    try {
      await this.send(sessionId, item.text, item)
    } catch {
      this.queueAdd(sessionId, item.text, item, true)
    }
  }

  /** On idle: send the next queued message, one per settle. */
  private drainQueue(sessionId: string): void {
    if (this.draining.has(sessionId)) return
    const q = this.queues.get(sessionId)
    if (!q?.length) return
    const item = q.shift()!
    this.notifyQueue(sessionId)
    this.draining.add(sessionId)
    void this.send(sessionId, item.text, item)
      .catch(() => {
        q.unshift(item)
        this.notifyQueue(sessionId)
      })
      .finally(() => this.draining.delete(sessionId))
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
