import {
  CROSS_HOST_CALL_MS,
  CROSS_HOST_CALL_SLACK_MS,
  CROSS_HOST_OFFER,
  CROSS_HOST_WAIT_WINDOW_MS,
  MAC_HOST_ALIAS,
  decodeAgentId,
  encodeAgentId,
  type CrossHostCaller,
  type CrossHostPeerMethod,
  type CrossHostSettled,
  type CrossHostThreadState,
  type ThreadCheckResult,
  type ThreadEventsResult,
  type ThreadSpawnArgs,
  type ThreadStartArgs,
  type ThreadStartResult,
  type ThreadWaitResult
} from '@shared/contract-crosshost'
import type { SessionMeta, SessionStatus } from '@shared/events'
import type { ResolvedSpawn } from './orchestration'
import { PeerOfflineError, type PeerCalls } from './remote/peerCalls'

/**
 * The box side of threads on another host (docs/box.md "Starting a thread
 * on the Mac from the box"). A thread here names a host when it starts a
 * thread or spawns an agent (`environmentId`, or `mac` for its own Mac), and
 * every id that comes back is `<environmentId>:<sessionId>`, so the
 * supervision tools route to that host without the model knowing. Nothing
 * here runs a thread: each call goes over the Mac's peer link as a
 * `peer.call` of the `threads` offer (remote/peerCalls.ts) and the Mac
 * serves it against its own registry (remote/crossHostThreads.ts).
 *
 *  - Which Mac: the thread's Mac bridge peer when set (`macBridge.thread.
 *    <id>`, an ancestor's counts), else the only Mac registered with the
 *    offer, else a refusal naming `macBridge.thread.set`.
 *  - A wait is a loop of calls no longer than CROSS_HOST_WAIT_WINDOW_MS each,
 *    so a link that drops mid-wait is noticed within a window: the call then
 *    answers the last state this box saw with `linkDown: true` instead of
 *    hanging or throwing.
 *  - What a thread started or spawned is kept here (`crossHost.children.
 *    <sessionId>`), so list_agents still names it, with its last known
 *    state, while the Mac is away, and a spawned agent is recorded in the
 *    parent's log (`agent-spawned` with the Mac's environment id) so the
 *    fleet view shows it beside the local children.
 */

export const CHILDREN_PREFIX = 'crossHost.children.'
/** Threads one box thread may have on other hosts (started and spawned together). */
export const CROSS_HOST_MAX_PER_THREAD = 64

/** The last state this box saw of a thread on a host, kept with the id. */
export interface RemoteChildRecord {
  environmentId: string
  sessionId: string
  title: string
  /** 'started' for app.startThread, 'spawned' for app.spawnAgent. */
  kind: 'started' | 'spawned'
  status: SessionStatus
  cwd: string
  provider: string
  model: string
  agentType: string
  seenAt: number
}

export interface CrossHostAgentsDeps {
  /** This box's own environment id. */
  environmentId: string
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
  }
  sessions: {
    get(id: string): SessionMeta | null | undefined
    append(id: string, event: { type: 'agent-spawned'; childSessionId: string; environmentId?: string }): void
    deliverAgentReport(id: string, report: { agentId: string; title: string; status: string; text: string }): void
  }
  calls: PeerCalls
  /** The Mac a thread's bridge names (macTools.ts macPeerOf), if any. */
  macPeerOf: (sessionId: string) => string | null
  /** Hosts this box knows by name, for the error text. */
  hostName?: (envId: string) => string | null
  /** Where this box's checkouts live (workRoot.ts): sent with the cwd so the Mac can map `<root>/<name>`. */
  workRoot: () => string
  log?: (line: string) => void
  now?: () => number
}

export interface StartOnHostArgs extends Omit<ThreadStartArgs, 'cwd' | 'workRoot'> {
  /** The box path the thread would work in (the caller's project cwd). */
  cwd: string
}

export interface RemoteWaitReport {
  agentId: string
  status: SessionStatus
  reply: string
  pending?: ThreadWaitResult['pending']
  title: string
  /** The link to the host dropped during the wait: the state is the last one seen. */
  linkDown?: true
  note?: string
}

export class CrossHostAgents {
  private readonly log: (line: string) => void
  /** Encoded ids a wait_for_agent currently covers: their settle report is that call's result, not a wake. */
  private readonly awaited = new Map<string, number>()

  constructor(private readonly deps: CrossHostAgentsDeps) {
    this.log = deps.log ?? ((line) => console.log(`[cross-host] ${line}`))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ── which host ─────────────────────────────────────────────────────

  /**
   * The host a thread means by `environmentId`: an id is itself; `mac` (or
   * nothing) is the thread's Mac bridge peer, else the only host registered
   * with the threads offer. Throws the refusal that tells the model what to set.
   */
  resolveHost(sessionId: string, environmentId?: string | null): string {
    const registered = this.deps.calls.registeredIds(CROSS_HOST_OFFER)
    const wanted = environmentId?.trim()
    if (wanted && wanted !== MAC_HOST_ALIAS) {
      if (!this.deps.calls.online(wanted, CROSS_HOST_OFFER))
        throw new Error(
          this.deps.calls.online(wanted)
            ? `Mac offline for threads: ${wanted} is linked but offers no threads (an older app there)`
            : `Mac offline: ${wanted} has no live link to this host`
        )
      return wanted
    }
    const bridged = this.deps.macPeerOf(sessionId)
    if (bridged) {
      if (!this.deps.calls.online(bridged, CROSS_HOST_OFFER))
        throw new Error(`Mac offline: ${bridged} has no live link to this host`)
      return bridged
    }
    if (registered.length === 1) return registered[0]
    if (registered.length === 0)
      throw new Error(
        'no Mac is linked to this host right now: open the Mac app, or name the host with macBridge.thread.set (the thread menu, "Mac bridge")'
      )
    throw new Error(
      `several Macs are linked (${registered.join(', ')}): pass environmentId, or pick one for this thread with macBridge.thread.set (the thread menu, "Mac bridge")`
    )
  }

  /** The hosts a thread could start a thread on right now, for tool text. */
  hostsOnline(): string[] {
    return this.deps.calls.registeredIds(CROSS_HOST_OFFER)
  }

  // ── the records ────────────────────────────────────────────────────

  children(sessionId: string): RemoteChildRecord[] {
    try {
      const raw = this.deps.store.getSetting(`${CHILDREN_PREFIX}${sessionId}`)
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(parsed) ? (parsed as RemoteChildRecord[]).filter((r) => r && typeof r.sessionId === 'string') : []
    } catch {
      return []
    }
  }

  private saveChildren(sessionId: string, list: RemoteChildRecord[]): void {
    this.deps.store.setSetting(`${CHILDREN_PREFIX}${sessionId}`, list.length ? JSON.stringify(list.slice(-CROSS_HOST_MAX_PER_THREAD)) : null)
  }

  private record(parentId: string, rec: RemoteChildRecord): void {
    const list = this.children(parentId).filter((r) => !(r.environmentId === rec.environmentId && r.sessionId === rec.sessionId))
    this.saveChildren(parentId, [...list, rec])
  }

  private touch(parentId: string, envId: string, state: Pick<CrossHostThreadState, 'sessionId' | 'status' | 'title'>): void {
    const list = this.children(parentId)
    const i = list.findIndex((r) => r.environmentId === envId && r.sessionId === state.sessionId)
    if (i < 0) return
    list[i] = { ...list[i], status: state.status, title: state.title, seenAt: this.now() }
    this.saveChildren(parentId, list)
  }

  /** The record a parent holds for an encoded id, or the refusal list_agents answers. */
  private childOf(parent: SessionMeta, agentId: string): RemoteChildRecord | null {
    let decoded: ReturnType<typeof decodeAgentId>
    try {
      decoded = decodeAgentId(agentId)
    } catch {
      return null
    }
    if (!decoded) return null
    return this.children(parent.id).find((r) => r.environmentId === decoded.environmentId && r.sessionId === decoded.sessionId) ?? null
  }

  /** True when the id names a thread on another host (whether or not this parent owns it). */
  isRemote(agentId: string): boolean {
    try {
      return decodeAgentId(agentId) !== null
    } catch {
      return false
    }
  }

  // ── the calls ──────────────────────────────────────────────────────

  private callerOf(session: SessionMeta): CrossHostCaller {
    return { environmentId: this.deps.environmentId, sessionId: session.id, title: session.title, permission: session.permission }
  }

  private call<T>(envId: string, session: SessionMeta, method: CrossHostPeerMethod, args: unknown, deadlineMs = CROSS_HOST_CALL_MS): Promise<T> {
    return this.deps.calls.call<T>(envId, method, { caller: this.callerOf(session), args: args as never }, deadlineMs)
  }

  private fresh(session: SessionMeta): SessionMeta {
    return this.deps.sessions.get(session.id) ?? session
  }

  /** app.startThread on a host: an ordinary thread there, listed under that host at once. */
  async startThread(
    caller: SessionMeta,
    environmentId: string | null | undefined,
    args: StartOnHostArgs
  ): Promise<{ threadId: string; title: string; host: string; cwd: string; projectId: string | null; cwdNote?: string }> {
    const session = this.fresh(caller)
    const host = this.resolveHost(session.id, environmentId)
    if (this.children(session.id).length >= CROSS_HOST_MAX_PER_THREAD)
      throw new Error(`this thread already has ${CROSS_HOST_MAX_PER_THREAD} threads on other hosts`)
    const wire: ThreadStartArgs = { ...args, workRoot: this.deps.workRoot() }
    const result = await this.call<ThreadStartResult>(host, session, 'thread.start', wire)
    this.record(session.id, {
      environmentId: host,
      sessionId: result.sessionId,
      title: result.title,
      kind: 'started',
      status: 'running',
      cwd: result.cwd,
      provider: args.provider,
      model: args.model ?? '',
      agentType: 'implementer',
      seenAt: this.now()
    })
    this.log(`thread=${session.id} started ${result.sessionId} on ${host} in ${result.cwd}`)
    return { threadId: encodeAgentId(host, result.sessionId), title: result.title, host, cwd: result.cwd, projectId: result.projectId, ...(result.cwdNote ? { cwdNote: result.cwdNote } : {}) }
  }

  /** app.spawnAgent on a host: one resolved entry becomes a child there, the parent's log records it here. */
  async spawn(
    caller: SessionMeta,
    environmentId: string | null | undefined,
    specs: ResolvedSpawn[]
  ): Promise<{ agentId: string; title: string; cwd: string; host: string; cwdNote?: string }[]> {
    const session = this.fresh(caller)
    const host = this.resolveHost(session.id, environmentId)
    if (this.children(session.id).length + specs.length > CROSS_HOST_MAX_PER_THREAD)
      throw new Error(`this thread may have at most ${CROSS_HOST_MAX_PER_THREAD} threads on other hosts`)
    const started: { agentId: string; title: string; cwd: string; host: string; cwdNote?: string }[] = []
    for (const r of specs) {
      const title = r.task.split('\n')[0].slice(0, 80) || `${r.provider} · ${r.agentType}`
      const wire: ThreadSpawnArgs = {
        provider: r.provider,
        model: r.model,
        reasoning: r.reasoning,
        context1m: r.context1m,
        agentType: r.agentType,
        task: r.task,
        title,
        useWorktree: r.useWorktree,
        cwd: session.cwd,
        workRoot: this.deps.workRoot()
      }
      const result = await this.call<ThreadStartResult>(host, session, 'thread.spawn', wire)
      this.record(session.id, {
        environmentId: host,
        sessionId: result.sessionId,
        title: result.title,
        kind: 'spawned',
        status: 'running',
        cwd: result.cwd,
        provider: r.provider,
        model: r.model,
        agentType: r.agentType,
        seenAt: this.now()
      })
      // The parent's own log says it spawned, with the host, so its fleet
      // view lists the child beside the local ones (the Mac's renderer
      // resolves the plain id to the session it holds).
      this.deps.sessions.append(session.id, { type: 'agent-spawned', childSessionId: result.sessionId, environmentId: host })
      this.log(`thread=${session.id} spawned ${result.sessionId} on ${host} in ${result.cwd}`)
      started.push({ agentId: encodeAgentId(host, result.sessionId), title: result.title, cwd: result.cwd, host, ...(result.cwdNote ? { cwdNote: result.cwdNote } : {}) })
    }
    return started
  }

  private notChild(agentId: string): string {
    return `refused: ${agentId} is not a subagent of this session. list_agents shows your agents and their ids.`
  }

  async send(caller: SessionMeta, agentId: string, message: string): Promise<string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    try {
      await this.call(rec.environmentId, session, 'thread.send', { sessionId: rec.sessionId, message })
      return 'sent'
    } catch (err) {
      return `failed: ${this.offlineText(err, rec)}`
    }
  }

  async check(caller: SessionMeta, agentId: string): Promise<string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    try {
      const r = await this.call<ThreadCheckResult>(rec.environmentId, session, 'thread.check', { sessionId: rec.sessionId })
      this.touch(session.id, rec.environmentId, r)
      return JSON.stringify({ agentId, host: rec.environmentId, title: r.title, status: r.status, idleForSeconds: r.idleForSeconds, currentTurn: r.currentTurn, pending: r.pending, tasks: r.tasks, cwd: r.cwd })
    } catch (err) {
      return JSON.stringify({ agentId, host: rec.environmentId, title: rec.title, status: rec.status, linkDown: true, note: this.offlineText(err, rec) })
    }
  }

  async events(caller: SessionMeta, agentId: string, afterSeq = 0, limit?: number): Promise<ThreadEventsResult | string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    try {
      return await this.call<ThreadEventsResult>(rec.environmentId, session, 'thread.events', { sessionId: rec.sessionId, afterSeq, ...(limit ? { limit } : {}) })
    } catch (err) {
      return `failed: ${this.offlineText(err, rec)}`
    }
  }

  async interrupt(caller: SessionMeta, agentId: string): Promise<string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    try {
      await this.call(rec.environmentId, session, 'thread.interrupt', { sessionId: rec.sessionId })
      return 'interrupted — send_to_agent to redirect, or spawn a replacement'
    } catch (err) {
      return `failed: ${this.offlineText(err, rec)}`
    }
  }

  async answer(caller: SessionMeta, agentId: string, requestId: string, answers?: string[][], allow?: boolean): Promise<string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    try {
      const r = await this.call<{ kind: 'question' | 'approval' }>(rec.environmentId, session, 'thread.answer', { sessionId: rec.sessionId, requestId, ...(answers ? { answers } : {}), ...(allow !== undefined ? { allow } : {}) })
      return r.kind === 'approval'
        ? `${allow ? 'allowed' : 'denied'} — the agent resumes; wait_for_agent to collect its result`
        : 'answered — the agent resumes; wait_for_agent to collect its result'
    } catch (err) {
      return `refused: ${this.offlineText(err, rec)}`
    }
  }

  /**
   * Block until the thread on the host settles or the timeout passes, in
   * windows of CROSS_HOST_WAIT_WINDOW_MS; a dropped link answers the last
   * known state with linkDown. `stop` ends the loop early (a wait over
   * several agents that another one settled first).
   */
  async wait(caller: SessionMeta, agentId: string, timeoutMs: number, stop?: { stopped: boolean }): Promise<RemoteWaitReport | string> {
    const session = this.fresh(caller)
    const rec = this.childOf(session, agentId)
    if (!rec) return this.notChild(agentId)
    const end = timeoutMs > 0 ? this.now() + timeoutMs : Infinity
    this.hold(agentId)
    try {
      for (;;) {
        if (stop?.stopped) return { agentId, status: rec.status, reply: '', title: rec.title, note: 'another agent settled first' }
        const window = Math.max(0, Math.min(CROSS_HOST_WAIT_WINDOW_MS, end - this.now()))
        let r: ThreadWaitResult
        try {
          r = await this.call<ThreadWaitResult>(rec.environmentId, session, 'thread.wait', { sessionId: rec.sessionId, deadlineMs: window }, window + CROSS_HOST_CALL_SLACK_MS)
        } catch (err) {
          const latest = this.childOf(session, agentId) ?? rec
          return { agentId, status: latest.status, reply: '', title: latest.title, linkDown: true, note: this.offlineText(err, rec) }
        }
        this.touch(session.id, rec.environmentId, r)
        if (r.settled) return { agentId, status: r.status, reply: r.reply || '(no reply yet)', ...(r.pending ? { pending: r.pending } : {}), title: r.title }
        if (this.now() >= end) return { agentId, status: r.status, reply: '', title: r.title, note: 'timeout — still running; check_agent shows progress' }
      }
    } finally {
      this.release(agentId)
    }
  }

  /** What list_agents adds for a thread: live state when the host answers, the last seen state with linkDown when not. */
  async list(caller: SessionMeta): Promise<Record<string, unknown>[]> {
    const session = this.fresh(caller)
    const recs = this.children(session.id)
    if (!recs.length) return []
    const byHost = new Map<string, RemoteChildRecord[]>()
    for (const r of recs) byHost.set(r.environmentId, [...(byHost.get(r.environmentId) ?? []), r])
    const out: Record<string, unknown>[] = []
    for (const [host, list] of byHost) {
      let live: Map<string, CrossHostThreadState> | null = null
      try {
        const states = await this.call<CrossHostThreadState[]>(host, session, 'thread.list', { sessionIds: list.map((r) => r.sessionId) })
        live = new Map(states.map((s) => [s.sessionId, s]))
        for (const s of states) this.touch(session.id, host, s)
      } catch {
        live = null
      }
      for (const r of list) {
        const s = live?.get(r.sessionId)
        out.push({
          agentId: encodeAgentId(host, r.sessionId),
          host,
          title: s?.title ?? r.title,
          provider: r.provider,
          model: r.model,
          agentType: r.agentType,
          kind: r.kind,
          status: s?.status ?? r.status,
          ...(s ? { idleForSeconds: s.idleForSeconds } : { linkDown: true, lastSeenAt: r.seenAt }),
          cwd: s?.cwd ?? r.cwd
        })
      }
    }
    return out
  }

  // ── a settle the Mac reports ───────────────────────────────────────

  private hold(agentId: string): void {
    this.awaited.set(agentId, (this.awaited.get(agentId) ?? 0) + 1)
  }
  private release(agentId: string): void {
    const n = (this.awaited.get(agentId) ?? 1) - 1
    if (n <= 0) this.awaited.delete(agentId)
    else this.awaited.set(agentId, n)
  }

  /** crossHost.settled from a Mac: the parent here learns of it as it would of a local child, unless a wait already covers it. */
  settled(from: string, params: CrossHostSettled): { ok: true } {
    if (params.from !== from) throw new Error('the report names another host')
    const agentId = encodeAgentId(from, params.sessionId)
    // The parent that holds the record: the spawning thread, else whichever thread started it.
    const parentId = params.parentSessionId && this.children(params.parentSessionId).some((r) => r.environmentId === from && r.sessionId === params.sessionId)
      ? params.parentSessionId
      : null
    if (!parentId) return { ok: true }
    this.touch(parentId, from, { sessionId: params.sessionId, status: params.status as SessionStatus, title: params.title })
    if (this.awaited.has(agentId)) return { ok: true }
    const parent = this.deps.sessions.get(parentId)
    if (!parent || parent.archived) return { ok: true }
    const body =
      params.status === 'waiting'
        ? params.pending?.kind === 'question'
          ? `It is WAITING on a question — answer it with answer_agent (requestId ${params.pending.requestId}).`
          : `It is WAITING on a permission approval — answer_agent with allow: true or false decides it (requestId ${params.pending?.requestId ?? '?'}).`
        : params.reply
          ? `Latest reply:\n${params.reply}`
          : '(no reply text)'
    this.deps.sessions.deliverAgentReport(parentId, {
      agentId,
      title: params.title,
      status: params.status,
      text: `<subagent-report>\nAutomatic notification: subagent "${params.title}" (${agentId}, on host ${this.deps.hostName?.(from) ?? from}) settled with status ${params.status}.\n${body}\nUse check_agent for detail, send_to_agent to follow up. Continue your work accordingly — do not reply to this notification itself.\n</subagent-report>`
    })
    return { ok: true }
  }

  private offlineText(err: unknown, rec: RemoteChildRecord): string {
    if (err instanceof PeerOfflineError) return `the link to ${this.deps.hostName?.(rec.environmentId) ?? rec.environmentId} is down; last seen ${rec.status}`
    return err instanceof Error ? err.message : String(err)
  }
}
