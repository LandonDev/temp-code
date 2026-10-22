import type { ServerPush } from '@shared/contract'
import type { MacBridgePush } from '@shared/contract-macbridge'
import {
  BOX_HOST_ALIAS,
  CROSS_HOST_CALL_MS,
  CROSS_HOST_CALL_SLACK_MS,
  CROSS_HOST_WAIT_WINDOW_MS,
  CrossHostLandingSchema,
  CrossHostSettledSchema,
  MAC_HOST_ALIAS,
  decodeAgentId,
  encodeAgentId,
  isCrossHostReportMethod,
  type CrossHostCaller,
  type CrossHostLanding,
  type CrossHostLandingResult,
  type CrossHostPeerMethod,
  type CrossHostSettled,
  type CrossHostThreadState,
  type ThreadAdoptResult,
  type ThreadCheckResult,
  type ThreadEventsResult,
  type ThreadSpawnArgs,
  type ThreadStartArgs,
  type ThreadStartResult,
  type ThreadWaitResult
} from '@shared/contract-crosshost'
import type { SessionMeta, SessionStatus } from '@shared/events'
import type { ProjectLinkFacts } from '@shared/projectLinks'
import { batchMembershipOf, type ResolvedSpawn } from './orchestration'
import type { HostTransport } from './remote/hostLinks'
import { PeerOfflineError, servePeerCall, type LinkRequest } from './remote/peerCalls'

/**
 * The asking side of threads on another host (docs/box.md "Threads across
 * hosts"). A thread here names a host when it starts a thread or spawns an
 * agent (`environmentId`: an id, `mac` for its Mac, `box` for the one host
 * linked from here), and every id that comes back is
 * `<environmentId>:<sessionId>`, so the supervision tools route to that
 * host without the model knowing. Nothing here runs a thread: each call
 * goes over whichever socket reaches the host (remote/hostLinks.ts: a
 * `peer.call` down a socket the host registered here, or a request on the
 * host's listener over this host's own link) and the host serves it against
 * its own registry (remote/crossHostThreads.ts). Both objects are built on
 * every host, so the Mac asks the box the way the box asks the Mac.
 *
 *  - Which host: an id is itself; `mac` is the thread's Mac bridge peer
 *    (`macBridge.thread.<id>`, an ancestor's counts), else the only host
 *    registered here with the offer; `box` is the only saved host this
 *    process holds a link to; nothing is the bridge peer, else the only
 *    host reachable either way. A refusal names what to set.
 *  - A wait is a loop of calls no longer than CROSS_HOST_WAIT_WINDOW_MS each,
 *    so a link that drops mid-wait is noticed within a window: the call then
 *    answers the last state this host saw with `linkDown: true` instead of
 *    hanging or throwing.
 *  - What a thread started or spawned is kept here (`crossHost.children.
 *    <sessionId>`), so list_agents still names it, with its last known
 *    state, while the host is away, and a spawned agent is recorded in the
 *    parent's log (`agent-spawned` with the host's environment id) so the
 *    fleet view shows it beside the local children.
 *  - A thread a master or a batch root starts on another host is a batch
 *    member there (thread.start carries the masterId) and is indexed here
 *    under the master (`crossHost.batch.<masterId>`), so the batch engine
 *    (batch.ts) counts it, pauses and archives it over the link, and takes
 *    its landing reports (`crossHost.landing`) from its host.
 */

export const CHILDREN_PREFIX = 'crossHost.children.'
/** The threads of a master's batch on other hosts: pointers into the parents' child records. */
export const BATCH_PREFIX = 'crossHost.batch.'
/** Threads one thread may have on other hosts (started and spawned together). */
export const CROSS_HOST_MAX_PER_THREAD = 64

/** The last state this host saw of a thread on another, kept with the id. */
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
  threadType?: string | null
  /** The master (here) whose batch the thread belongs to. */
  masterId?: string
  seenAt: number
}

/** One line of the batch index: where the record lives. */
interface BatchPointer {
  parentId: string
  environmentId: string
  sessionId: string
}

/** What a remote batch child's landing tells the engine (batch.ts remoteLanding). */
export interface RemoteLanding {
  masterId: string
  environmentId: string
  sessionId: string
  phase: 'ask' | 'landed'
  branch: string
  target: string
  subjects: string[]
  sha?: string
}

export interface CrossHostAgentsDeps {
  /** This host's own environment id. */
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
  /** How the other hosts are reached (remote/hostLinks.ts). */
  links: HostTransport
  /** The link this host holds to a host, for answering its `peer.call` reports (the Mac answering the box). */
  link?: (envId: string) => LinkRequest | null
  /** The Mac a thread's bridge names (macTools.ts macPeerOf), if any. */
  macPeerOf: (sessionId: string) => string | null
  /** Hosts this host knows by name, for the error text. */
  hostName?: (envId: string) => string | null
  /** Where this host's checkouts live (workRoot.ts): sent with the cwd so the other host can map `<root>/<name>`. */
  workRoot: () => string
  /**
   * The caller's project as a far start carries it (sessions.ts
   * projectLinkFacts: mints and stamps the link ids a row lacks), so the far
   * host lands the thread in its linked copy (projectLinks.ts ensureLinked).
   */
  projectLink?: (projectId: string) => ProjectLinkFacts | null
  /** A batch child on another host is landing: the engine decides a hold and records a landing (batch.ts). */
  landing?: (l: RemoteLanding) => CrossHostLandingResult
  /** A batch child on another host changed state: the engine reviews the batch (batch.ts schedule). */
  batchChanged?: (masterId: string) => void
  log?: (line: string) => void
  now?: () => number
}

export interface StartOnHostArgs extends Omit<ThreadStartArgs, 'cwd' | 'workRoot' | 'project'> {
  /** The path here the thread would work in (the caller's project cwd). */
  cwd: string
  /** The project here the thread belongs to: its link facts ride along. */
  projectId?: string | null
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

export type RemoteBatchAction = 'pause' | 'resume' | 'archive'

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
   * The host a thread means by `environmentId`: an id is itself; `mac` is
   * the thread's Mac bridge peer, else the only host registered here; `box`
   * the only host linked from here; nothing is the bridge peer, else the
   * only host reachable either way. Throws the refusal that tells the model
   * what to set.
   */
  resolveHost(sessionId: string, environmentId?: string | null): string {
    const reachable = this.deps.links.reachable()
    const wanted = environmentId?.trim()
    if (wanted && wanted !== MAC_HOST_ALIAS && wanted !== BOX_HOST_ALIAS) {
      const refusal = this.deps.links.refusal(wanted)
      if (refusal) throw new Error(refusal)
      return wanted
    }
    if (wanted === BOX_HOST_ALIAS) {
      const linked = reachable.filter((r) => r.via === 'link')
      if (linked.length === 1) return linked[0].id
      if (linked.length === 0)
        throw new Error('no host is linked from here right now: save the box under Settings → Remote access, or name a host registered here by its environment id')
      throw new Error(`several hosts are linked from here (${linked.map((r) => r.id).join(', ')}): pass environmentId`)
    }
    const bridged = this.deps.macPeerOf(sessionId)
    if (bridged) {
      const refusal = this.deps.links.refusal(bridged)
      if (refusal) throw new Error(refusal.replace(/^host offline/, 'Mac offline'))
      return bridged
    }
    const pool = wanted === MAC_HOST_ALIAS ? reachable.filter((r) => r.via === 'registered') : reachable
    if (pool.length === 1) return pool[0].id
    if (pool.length === 0)
      throw new Error(
        'no Mac is linked to this host right now: open the Mac app, or name the host with macBridge.thread.set (the thread menu, "Mac bridge")'
      )
    throw new Error(
      `several hosts are linked (${pool.map((r) => r.id).join(', ')}): pass environmentId, or pick one for this thread with macBridge.thread.set (the thread menu, "Mac bridge")`
    )
  }

  /** The hosts a thread could start a thread on right now, for tool text: each with its name and the alias that names it. */
  hostsOnline(): { id: string; name: string; alias: typeof MAC_HOST_ALIAS | typeof BOX_HOST_ALIAS | null }[] {
    const reachable = this.deps.links.reachable()
    const registered = reachable.filter((r) => r.via === 'registered')
    const linked = reachable.filter((r) => r.via === 'link')
    return reachable.map((r) => ({
      id: r.id,
      name: this.deps.hostName?.(r.id) ?? r.id,
      alias: r.via === 'registered' ? (registered.length === 1 ? MAC_HOST_ALIAS : null) : linked.length === 1 ? BOX_HOST_ALIAS : null
    }))
  }

  /** One line for a tool description: "mac = Landon Mac (env_…), box = The box (env_…)". */
  hostsLine(): string {
    const hosts = this.hostsOnline()
    if (!hosts.length) return 'no other host is reachable right now'
    return hosts.map((h) => `${h.alias ? `${h.alias} = ` : ''}${h.name} (${h.id})`).join(', ')
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
    if (rec.masterId) this.index(rec.masterId, { parentId, environmentId: rec.environmentId, sessionId: rec.sessionId })
  }

  private touch(parentId: string, envId: string, state: Pick<CrossHostThreadState, 'sessionId' | 'status' | 'title'>): void {
    const list = this.children(parentId)
    const i = list.findIndex((r) => r.environmentId === envId && r.sessionId === state.sessionId)
    if (i < 0) return
    const before = list[i]
    list[i] = { ...before, status: state.status, title: state.title, seenAt: this.now() }
    this.saveChildren(parentId, list)
    if (before.masterId && before.status !== state.status) this.deps.batchChanged?.(before.masterId)
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

  // ── the batch index ────────────────────────────────────────────────

  private pointers(masterId: string): BatchPointer[] {
    try {
      const raw = this.deps.store.getSetting(`${BATCH_PREFIX}${masterId}`)
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(parsed) ? (parsed as BatchPointer[]).filter((p) => p && typeof p.sessionId === 'string' && typeof p.parentId === 'string') : []
    } catch {
      return []
    }
  }

  private index(masterId: string, p: BatchPointer): void {
    const list = this.pointers(masterId).filter((x) => !(x.environmentId === p.environmentId && x.sessionId === p.sessionId))
    this.deps.store.setSetting(`${BATCH_PREFIX}${masterId}`, JSON.stringify([...list, p].slice(-CROSS_HOST_MAX_PER_THREAD * 4)))
  }

  /** The threads of a master's batch on other hosts, with the state this host last saw, oldest first. */
  batchChildren(masterId: string): RemoteChildRecord[] {
    const out: RemoteChildRecord[] = []
    for (const p of this.pointers(masterId)) {
      const rec = this.children(p.parentId).find((r) => r.environmentId === p.environmentId && r.sessionId === p.sessionId)
      if (rec && rec.masterId === masterId) out.push(rec)
    }
    return out
  }

  /** The caller a batch call goes out as: the thread that started the child, or its id when it is gone. */
  private batchCaller(masterId: string, rec: RemoteChildRecord): { parentId: string; caller: CrossHostCaller } | null {
    const p = this.pointers(masterId).find((x) => x.environmentId === rec.environmentId && x.sessionId === rec.sessionId)
    if (!p) return null
    const parent = this.deps.sessions.get(p.parentId)
    const caller: CrossHostCaller = parent
      ? this.callerOf(parent)
      : { environmentId: this.deps.environmentId, sessionId: p.parentId, title: '', permission: 'safe' }
    return { parentId: p.parentId, caller }
  }

  /**
   * The batch's children on other hosts as their hosts see them now (one
   * thread.list per host); a host out of reach keeps the last state and is
   * named in `unreachable`. The engine calls this when it reviews a batch.
   */
  async refreshBatch(masterId: string): Promise<{ children: RemoteChildRecord[]; unreachable: string[] }> {
    const recs = this.batchChildren(masterId)
    const byHost = new Map<string, RemoteChildRecord[]>()
    for (const r of recs) byHost.set(r.environmentId, [...(byHost.get(r.environmentId) ?? []), r])
    const unreachable: string[] = []
    for (const [host, list] of byHost) {
      const first = this.batchCaller(masterId, list[0])
      if (!first) continue
      try {
        const states = await this.deps.links.call<CrossHostThreadState[]>(
          host,
          'thread.list',
          { caller: first.caller, args: { sessionIds: list.map((r) => r.sessionId) } },
          CROSS_HOST_CALL_MS
        )
        for (const s of states) {
          const p = this.pointers(masterId).find((x) => x.environmentId === host && x.sessionId === s.sessionId)
          if (p) this.touch(p.parentId, host, s)
        }
      } catch {
        unreachable.push(host)
      }
    }
    return { children: this.batchChildren(masterId), unreachable }
  }

  /** Pause, resume or archive the batch's children on other hosts (the master's cascade, `batch.archive`): each on its host, every outcome kept. */
  async batchAction(
    masterId: string,
    action: RemoteBatchAction,
    ids?: readonly string[]
  ): Promise<{ succeeded: string[]; failed: { sessionId: string; error: string }[] }> {
    const succeeded: string[] = []
    const failed: { sessionId: string; error: string }[] = []
    for (const rec of this.batchChildren(masterId)) {
      const encoded = encodeAgentId(rec.environmentId, rec.sessionId)
      if (ids && !ids.includes(encoded)) continue
      const who = this.batchCaller(masterId, rec)
      if (!who) continue
      try {
        await this.deps.links.call(rec.environmentId, `thread.${action}`, { caller: who.caller, args: { sessionId: rec.sessionId } }, CROSS_HOST_CALL_MS)
        if (action === 'archive') this.touch(who.parentId, rec.environmentId, { sessionId: rec.sessionId, status: 'done', title: rec.title })
        succeeded.push(encoded)
      } catch (err) {
        failed.push({ sessionId: encoded, error: this.offlineText(err, rec) })
      }
    }
    if (action === 'archive' && succeeded.length) this.forgetFromBatch(masterId, succeeded)
    return { succeeded, failed }
  }

  /**
   * `batch.adopt` with `<envId>:<sessionId>` ids: each root is adopted on
   * its host (thread.adopt: it takes the master's id there and this host
   * becomes its owner) and recorded here under the master. Refusals come
   * back per id with the host's reason; a host out of reach is one too.
   */
  async adopt(master: SessionMeta, encodedIds: readonly string[]): Promise<{ adopted: string[]; refused: { sessionId: string; why: string }[] }> {
    const adopted: string[] = []
    const refused: { sessionId: string; why: string }[] = []
    for (const id of new Set(encodedIds)) {
      let decoded: ReturnType<typeof decodeAgentId>
      try {
        decoded = decodeAgentId(id)
      } catch {
        decoded = null
      }
      if (!decoded) {
        refused.push({ sessionId: id, why: 'not a thread on another host' })
        continue
      }
      try {
        const r = await this.deps.links.call<ThreadAdoptResult>(
          decoded.environmentId,
          'thread.adopt',
          { caller: this.callerOf(master), args: { sessionId: decoded.sessionId, masterId: master.id } },
          CROSS_HOST_CALL_MS
        )
        this.record(master.id, {
          environmentId: decoded.environmentId,
          sessionId: r.sessionId,
          title: r.title,
          kind: 'started',
          status: r.status,
          cwd: r.cwd,
          provider: r.provider,
          model: r.model,
          agentType: r.agentType,
          threadType: r.threadType,
          masterId: master.id,
          seenAt: this.now()
        })
        adopted.push(id)
      } catch (err) {
        refused.push({
          sessionId: id,
          why: err instanceof PeerOfflineError ? `the link to ${this.deps.hostName?.(decoded.environmentId) ?? decoded.environmentId} is down` : err instanceof Error ? err.message : String(err)
        })
      }
    }
    if (adopted.length) this.deps.batchChanged?.(master.id)
    return { adopted, refused }
  }

  /** Archived children leave the batch index (their records stay with their parent, marked done). */
  private forgetFromBatch(masterId: string, encodedIds: readonly string[]): void {
    const all = this.pointers(masterId)
    const gone = all.filter((p) => encodedIds.includes(encodeAgentId(p.environmentId, p.sessionId)))
    const keep = all.filter((p) => !gone.includes(p))
    this.deps.store.setSetting(`${BATCH_PREFIX}${masterId}`, keep.length ? JSON.stringify(keep) : null)
    for (const p of gone) this.dropMaster(p.parentId, p.environmentId, p.sessionId)
    this.deps.batchChanged?.(masterId)
  }

  private dropMaster(parentId: string, envId: string, sessionId: string): void {
    const list = this.children(parentId)
    const i = list.findIndex((r) => r.environmentId === envId && r.sessionId === sessionId)
    if (i < 0) return
    const { masterId: _gone, ...rest } = list[i]
    list[i] = rest
    this.saveChildren(parentId, list)
  }

  // ── the calls ──────────────────────────────────────────────────────

  private callerOf(session: SessionMeta): CrossHostCaller {
    return { environmentId: this.deps.environmentId, sessionId: session.id, title: session.title, permission: session.permission }
  }

  private call<T>(envId: string, session: SessionMeta, method: CrossHostPeerMethod, args: unknown, deadlineMs = CROSS_HOST_CALL_MS): Promise<T> {
    return this.deps.links.call<T>(envId, method, { caller: this.callerOf(session), args }, deadlineMs)
  }

  /** The link facts of a project here, the ids minted on first use; null with no project. */
  private projectFacts(projectId: string | null | undefined): ProjectLinkFacts | null {
    return projectId ? (this.deps.projectLink?.(projectId) ?? null) : null
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
    // The batch follows the starter here as on this host (orchestration.ts batchMembershipOf).
    const membership = batchMembershipOf(session)
    const { projectId, ...rest } = args
    const project = this.projectFacts(projectId)
    const wire: ThreadStartArgs = { ...rest, workRoot: this.deps.workRoot(), ...membership, ...(project ? { project } : {}) }
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
      threadType: args.threadType,
      ...('masterId' in membership ? { masterId: membership.masterId } : {}),
      seenAt: this.now()
    })
    if ('masterId' in membership) this.deps.batchChanged?.(membership.masterId)
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
    const project = this.projectFacts(session.projectId)
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
        workRoot: this.deps.workRoot(),
        ...(r.preamble ? {} : { preamble: false }),
        ...(project ? { project } : {})
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
      // view lists the child beside the local ones (the host's renderer
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
          hostName: this.deps.hostName?.(host) ?? host,
          title: s?.title ?? r.title,
          provider: r.provider,
          model: r.model,
          agentType: r.agentType,
          kind: r.kind,
          ...(r.masterId ? { batch: r.masterId } : {}),
          status: s?.status ?? r.status,
          ...(s ? { idleForSeconds: s.idleForSeconds } : { linkDown: true, lastSeenAt: r.seenAt }),
          cwd: s?.cwd ?? r.cwd
        })
      }
    }
    return out
  }

  // ── reports a host sends back ──────────────────────────────────────

  private hold(agentId: string): void {
    this.awaited.set(agentId, (this.awaited.get(agentId) ?? 0) + 1)
  }
  private release(agentId: string): void {
    const n = (this.awaited.get(agentId) ?? 1) - 1
    if (n <= 0) this.awaited.delete(agentId)
    else this.awaited.set(agentId, n)
  }

  /** The parent that holds the record of a thread on a host: the thread that spawned it, else any thread of a batch that started it. */
  private parentOf(from: string, sessionId: string, hint?: string | null): string | null {
    if (hint && this.children(hint).some((r) => r.environmentId === from && r.sessionId === sessionId)) return hint
    return null
  }

  /** crossHost.settled from a host: the parent here learns of it as it would of a local child, unless a wait already covers it. */
  settled(from: string, params: CrossHostSettled): { ok: true } {
    if (params.from !== from) throw new Error('the report names another host')
    const agentId = encodeAgentId(from, params.sessionId)
    const parentId = this.parentOf(from, params.sessionId, params.parentSessionId)
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

  /** crossHost.landing from a host: a batch child there is landing; the engine here decides a hold and counts the landing. */
  landing(from: string, params: CrossHostLanding): CrossHostLandingResult {
    if (params.from !== from) throw new Error('the report names another host')
    const rec = this.batchChildren(params.masterId).find((r) => r.environmentId === from && r.sessionId === params.sessionId)
    if (!rec) throw new Error(`${params.sessionId} on ${from} is not a thread of the batch of ${params.masterId} here`)
    if (!this.deps.landing) return { hold: false }
    return this.deps.landing({
      masterId: params.masterId,
      environmentId: from,
      sessionId: params.sessionId,
      phase: params.phase,
      branch: params.branch,
      target: params.target,
      subjects: params.subjects,
      ...(params.sha ? { sha: params.sha } : {})
    })
  }

  /** A `peer.call` push from a host that runs threads for this one (the box, down this Mac's link): its reports are served here. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isCrossHostReportMethod(push.method as string)) return false
    const request = this.deps.link?.(from)
    if (!request) return true
    void servePeerCall(
      push as Extract<MacBridgePush, { push: 'peer.call' }>,
      from,
      async (method, params) => {
        if ((method as string) === 'crossHost.settled') return this.settled(from, CrossHostSettledSchema.parse(params))
        return this.landing(from, CrossHostLandingSchema.parse(params))
      },
      request,
      this.log
    )
    return true
  }

  private offlineText(err: unknown, rec: RemoteChildRecord): string {
    if (err instanceof PeerOfflineError) return `the link to ${this.deps.hostName?.(rec.environmentId) ?? rec.environmentId} is down; last seen ${rec.status}`
    return err instanceof Error ? err.message : String(err)
  }
}
