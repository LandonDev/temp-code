import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ServerPush } from '@shared/contract'
import {
  CROSS_HOST_OFFER,
  CROSS_HOST_REPLY_MAX,
  CROSS_HOST_ROW_TEXT_MAX,
  CrossHostCallerSchema,
  ThreadAnswerArgsSchema,
  ThreadCheckArgsSchema,
  ThreadEventsArgsSchema,
  ThreadInterruptArgsSchema,
  ThreadListArgsSchema,
  ThreadSendArgsSchema,
  ThreadSpawnArgsSchema,
  ThreadStartArgsSchema,
  ThreadWaitArgsSchema,
  isCrossHostPeerMethod,
  type CrossHostCallParams,
  type CrossHostCaller,
  type CrossHostPeerMethod,
  type CrossHostThreadState,
  type ThreadCheckResult,
  type ThreadEventsResult,
  type ThreadPending,
  type ThreadSpawnArgs,
  type ThreadStartArgs,
  type ThreadStartResult,
  type ThreadWaitResult
} from '@shared/contract-crosshost'
import type { EventRow, SessionMeta, SessionStatus } from '@shared/events'
import {
  latestTurnRows,
  pendingOf,
  todoProgress,
  toolLinesOf,
  turnText,
  waitForSettled,
  worktreeFor
} from '../orchestration'
import { stripSlash, type HistoryMapping } from '../pathMap'
import type { SessionRegistry } from '../sessions'
import { servePeerCall, type LinkRequest } from './peerCalls'

/**
 * The Mac side of threads started from another host (docs/box.md "Starting
 * a thread on the Mac from the box"). A box thread's thread.* call arrives
 * as a `peer.call` push on the link this Mac's main process holds to that
 * box (the same reverse RPC the Mac bridge uses, remote/peerCalls.ts), and
 * this Mac runs it against its own registry exactly as the local app tools
 * would: the thread is an ordinary thread here, listed under This Mac the
 * moment it is created, with the box thread's permission.
 *
 *  - Only a saved host may call, and every later call must name a thread
 *    this host started or spawned here (`crossHost.owner.<sessionId>`): a
 *    box never reaches a thread of this Mac's own or another host's.
 *  - The box names where it works (its project cwd); the Mac maps that
 *    onto its own checkout through the inverse of its path map (the one
 *    the harness sync and the history import share) and its work root.
 *    When nothing is there, the thread starts in the Mac's work root and
 *    the result says so.
 *  - A spawned agent carries the box thread's id as its parentId, so this
 *    Mac's fleet view shows it under the box thread it lists over the
 *    link, and a settle is reported back to the box (`crossHost.settled`,
 *    which wakes the box thread the way a local child's settle would).
 */

export const OWNER_PREFIX = 'crossHost.owner.'
export const STARTED_PREFIX = 'crossHost.started.'
/** Between a settle and the report, so a thread that goes straight into its next queued turn is not announced twice. */
const SETTLE_DEBOUNCE_MS = 300

export interface CrossHostThreadsDeps {
  /** This Mac's own environment id. */
  environmentId: string
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
  }
  registry: Pick<
    SessionRegistry,
    | 'create'
    | 'send'
    | 'get'
    | 'eventsAfter'
    | 'interrupt'
    | 'answer'
    | 'approve'
    | 'lastActivityAt'
    | 'subscribe'
    | 'onMeta'
    | 'listProjects'
  >
  /** The saved hosts (remote.environments), by id and name. */
  environments: () => { id: string; name: string }[]
  /** How to send on the link to a host, while it is up. */
  link: (envId: string) => LinkRequest | null
  /** This Mac's path map: its own paths → the box's (remote/harnessSync.ts pathMap). */
  pathMap: () => HistoryMapping
  /** Where this Mac's checkouts live (workRoot.ts). */
  workRoot: () => string
  exists?: (path: string) => boolean
  worktree?: typeof worktreeFor
  log?: (line: string) => void
}

const isDir = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A box path on this Mac: the inverse of the map (box destinations back to
 * their Mac sources, longest first), else `<boxWorkRoot>/<rest>` under the
 * Mac's work root, else nothing.
 */
export function macPathFor(
  boxPath: string,
  mapping: HistoryMapping,
  macWorkRoot: string,
  boxWorkRoot?: string
): string | null {
  if (!isAbsolute(boxPath)) return null
  const clean = stripSlash(boxPath)
  const under = (path: string, root: string): boolean =>
    path === root || path.startsWith(root === '/' ? '/' : root + '/')
  const inverted: [string, string][] = [
    ...Object.entries(mapping.roots),
    ...Object.entries(mapping.prefixes)
  ]
    .map(([from, to]): [string, string] => [stripSlash(to), stripSlash(from)])
    .filter(([to]) => to !== '/')
    .sort((a, b) => b[0].length - a[0].length)
  for (const [to, from] of inverted) if (under(clean, to)) return join(from, clean.slice(to.length))
  if (boxWorkRoot) {
    const root = stripSlash(boxWorkRoot)
    if (root !== '/' && under(clean, root)) return join(stripSlash(macWorkRoot), clean.slice(root.length))
  }
  return null
}

/** The long strings of an event cut to the wire bound; nothing else changes. */
export function trimEvent(event: Record<string, unknown>, max = CROSS_HOST_ROW_TEXT_MAX): Record<string, unknown> {
  const cut = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…[${value.length - max} more]` : value
    if (Array.isArray(value)) return value.map(cut)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cut(v)
      return out
    }
    return value
  }
  return cut(event) as Record<string, unknown>
}

const unsettled = (status: SessionStatus): boolean =>
  status === 'starting' || status === 'running' || status === 'watching'

const pendingShape = (rows: EventRow[]): ThreadPending | null => {
  const p = pendingOf(rows)
  if (!p) return null
  return p.kind === 'question'
    ? { kind: 'question', requestId: p.requestId, questions: p.questions }
    : { kind: 'approval', requestId: p.requestId, toolName: p.toolName, ...(p.title ? { title: p.title } : {}) }
}

export class CrossHostThreads {
  private readonly log: (line: string) => void
  private readonly lastStatus = new Map<string, SessionStatus>()
  private readonly settleTimers = new Map<string, NodeJS.Timeout>()
  private readonly offMeta: () => void

  constructor(private readonly deps: CrossHostThreadsDeps) {
    this.log = deps.log ?? ((line) => console.log(`[cross-host] ${line}`))
    this.offMeta = deps.registry.onMeta((meta) => this.onMeta(meta))
  }

  close(): void {
    this.offMeta()
    for (const t of this.settleTimers.values()) clearTimeout(t)
    this.settleTimers.clear()
  }

  /** The host that started a thread here, while it exists. */
  ownerOf(sessionId: string): string | null {
    return this.deps.store.getSetting(`${OWNER_PREFIX}${sessionId}`)
  }

  private startedKey(caller: CrossHostCaller): string {
    return `${STARTED_PREFIX}${caller.environmentId}.${caller.sessionId}`
  }

  private startedBy(caller: CrossHostCaller): string[] {
    try {
      const raw = this.deps.store.getSetting(this.startedKey(caller))
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  private remember(caller: CrossHostCaller, sessionId: string): void {
    this.deps.store.setSetting(`${OWNER_PREFIX}${sessionId}`, caller.environmentId)
    const list = this.startedBy(caller)
    if (!list.includes(sessionId)) this.deps.store.setSetting(this.startedKey(caller), JSON.stringify([...list, sessionId].slice(-200)))
  }

  /** A push from a host: a thread.* peer.call is served and answered on the same link. */
  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isCrossHostPeerMethod(push.method)) return false
    const request = this.deps.link(envId)
    if (!request) return true
    void servePeerCall(
      push,
      envId,
      (method, params, ctx) => this.handle(method as CrossHostPeerMethod, params as CrossHostCallParams, ctx),
      request,
      this.log
    )
    return true
  }

  async handle(
    method: CrossHostPeerMethod,
    params: CrossHostCallParams,
    ctx: { from: string; deadlineAt: number }
  ): Promise<unknown> {
    const env = this.deps.environments().find((e) => e.id === ctx.from)
    if (!env) throw new Error('this Mac does not know that host')
    const caller = CrossHostCallerSchema.parse(params?.caller)
    if (caller.environmentId !== ctx.from) throw new Error('the call names another host as its caller')
    const line = (what: string): void => this.log(`${env.name} (${env.id}) thread=${caller.sessionId} ${method} → ${what}`)
    const args = params.args as Record<string, unknown>
    switch (method) {
      case 'thread.start': {
        const result = await this.start(caller, ThreadStartArgsSchema.parse(args))
        line(`started ${result.sessionId} in ${result.cwd}${result.cwdNote ? ' (work root)' : ''}`)
        return result
      }
      case 'thread.spawn': {
        const result = await this.spawn(caller, ThreadSpawnArgsSchema.parse(args))
        line(`spawned ${result.sessionId} in ${result.cwd}${result.cwdNote ? ' (work root)' : ''}`)
        return result
      }
      case 'thread.send': {
        const a = ThreadSendArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        await this.deps.registry.send(a.sessionId, a.message)
        line(`sent to ${a.sessionId}`)
        return { ok: true }
      }
      case 'thread.list': {
        const a = ThreadListArgsSchema.parse(args)
        const ids = a.sessionIds ?? this.startedBy(caller)
        return ids
          .filter((id) => this.ownerOf(id) === caller.environmentId)
          .map((id) => this.deps.registry.get(id))
          .filter((m): m is SessionMeta => !!m)
          .map((m) => this.stateOf(m))
      }
      case 'thread.events': {
        const a = ThreadEventsArgsSchema.parse(args)
        const meta = this.own(caller, a.sessionId)
        const all = this.deps.registry.eventsAfter(a.sessionId, a.afterSeq ?? 0)
        const rows = all.slice(0, a.limit ?? 200)
        const result: ThreadEventsResult = {
          sessionId: a.sessionId,
          rows: rows.map((r) => ({ seq: r.seq, ts: r.ts, event: trimEvent(r.event as unknown as Record<string, unknown>) })),
          lastSeq: all.length ? all[all.length - 1].seq : (a.afterSeq ?? 0),
          status: meta.status
        }
        return result
      }
      case 'thread.check': {
        const a = ThreadCheckArgsSchema.parse(args)
        return this.check(this.own(caller, a.sessionId))
      }
      case 'thread.wait': {
        const a = ThreadWaitArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        const budget = Math.max(0, Math.min(a.deadlineMs, ctx.deadlineAt - Date.now() - 2_000))
        return this.wait(a.sessionId, budget)
      }
      case 'thread.interrupt': {
        const a = ThreadInterruptArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        await this.deps.registry.interrupt(a.sessionId)
        line(`interrupted ${a.sessionId}`)
        return { ok: true }
      }
      case 'thread.answer': {
        const a = ThreadAnswerArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        const pending = pendingOf(this.deps.registry.eventsAfter(a.sessionId, 0))
        if (!pending || pending.requestId !== a.requestId)
          throw new Error(`${a.requestId} is not this thread's pending request${pending ? ` (current: ${pending.requestId})` : ' (nothing pending)'}`)
        if (pending.kind === 'approval') {
          if (a.allow === undefined) throw new Error('this thread is waiting on a permission approval: pass allow')
          await this.deps.registry.approve(a.sessionId, a.requestId, a.allow)
          line(`${a.allow ? 'allowed' : 'denied'} ${a.requestId} on ${a.sessionId}`)
          return { ok: true, kind: 'approval' }
        }
        if (!a.answers) throw new Error('this thread is waiting on a question: pass answers')
        await this.deps.registry.answer(a.sessionId, a.requestId, a.answers)
        line(`answered ${a.requestId} on ${a.sessionId}`)
        return { ok: true, kind: 'question' }
      }
    }
  }

  /** The thread a call names, only when this caller's host started it here. */
  private own(caller: CrossHostCaller, sessionId: string): SessionMeta {
    if (this.ownerOf(sessionId) !== caller.environmentId)
      throw new Error(`${sessionId} is not a thread this host started on the Mac`)
    const meta = this.deps.registry.get(sessionId)
    if (!meta) throw new Error(`unknown session: ${sessionId}`)
    return meta
  }

  /** Where a thread for a box path works here, and the project that is, if any. */
  private place(boxCwd: string, boxWorkRoot?: string): { cwd: string; projectId: string | null; cwdNote?: string } {
    const exists = this.deps.exists ?? isDir
    const root = stripSlash(this.deps.workRoot())
    const mapped = macPathFor(boxCwd, this.deps.pathMap(), root, boxWorkRoot)
    const cwd = mapped && exists(mapped) ? stripSlash(mapped) : null
    const projectOf = (path: string): string | null =>
      this.deps.registry.listProjects().find((p) => stripSlash(p.cwd) === path)?.id ?? null
    if (cwd) return { cwd, projectId: projectOf(cwd) }
    return {
      cwd: root,
      projectId: projectOf(root),
      cwdNote: `the Mac has no checkout for ${boxCwd}${mapped ? ` (looked for ${mapped})` : ''}; the thread starts in the Mac's work root ${root}`
    }
  }

  private async start(caller: CrossHostCaller, args: ThreadStartArgs): Promise<ThreadStartResult> {
    const placed = this.place(args.cwd, args.workRoot)
    const planPath =
      args.planPath && (args.threadType === 'implementation' || args.threadType === 'orchestration')
        ? (macPathFor(args.planPath, this.deps.pathMap(), stripSlash(this.deps.workRoot()), args.workRoot) ?? undefined)
        : undefined
    const thread = await this.deps.registry.create({
      provider: args.provider,
      model: args.model,
      reasoning: args.reasoning,
      permission: caller.permission,
      ...(args.context1m ? { context1m: true } : {}),
      projectId: placed.projectId,
      threadType: args.threadType,
      ...(planPath && existsSync(planPath) ? { planPath } : {}),
      title: args.title,
      parentId: null,
      cwd: placed.cwd
    })
    this.remember(caller, thread.id)
    this.lastStatus.set(thread.id, thread.status)
    await this.deps.registry.send(thread.id, args.firstMessage)
    const created = this.deps.registry.get(thread.id) ?? thread
    return { sessionId: thread.id, title: created.title, cwd: placed.cwd, projectId: placed.projectId, ...(placed.cwdNote ? { cwdNote: placed.cwdNote } : {}) }
  }

  private async spawn(caller: CrossHostCaller, args: ThreadSpawnArgs): Promise<ThreadStartResult> {
    const placed = this.place(args.cwd, args.workRoot)
    const writer = args.agentType === 'implementer'
    const cwd =
      (writer && args.useWorktree
        ? await (this.deps.worktree ?? worktreeFor)(placed.cwd, `${caller.sessionId}-${Date.now() % 100000}`)
        : null) ?? placed.cwd
    const child = await this.deps.registry.create({
      provider: args.provider,
      model: args.model,
      reasoning: args.reasoning,
      agentType: args.agentType,
      ...(args.context1m ? { context1m: true } : {}),
      permission: caller.permission,
      projectId: placed.projectId,
      cwd,
      title: args.title,
      // The box thread is the parent: this Mac lists that thread over its
      // link, so its fleet view shows the child under it (the parent's own
      // log lives on the box, which records the spawn there).
      parentId: caller.sessionId
    })
    this.remember(caller, child.id)
    this.lastStatus.set(child.id, child.status)
    await this.deps.registry.send(child.id, args.task)
    return { sessionId: child.id, title: child.title, cwd, projectId: placed.projectId, ...(placed.cwdNote ? { cwdNote: placed.cwdNote } : {}) }
  }

  private stateOf(m: SessionMeta): CrossHostThreadState {
    return {
      sessionId: m.id,
      title: m.title,
      provider: m.provider,
      model: m.model,
      agentType: m.agentType,
      threadType: m.threadType,
      status: m.status,
      cwd: m.cwd,
      idleForSeconds: Math.max(0, Math.round((Date.now() - this.deps.registry.lastActivityAt(m.id)) / 1000)),
      parentSessionId: m.parentId
    }
  }

  private check(meta: SessionMeta): ThreadCheckResult {
    const rows = this.deps.registry.eventsAfter(meta.id, 0)
    const turn = latestTurnRows(rows)
    const finals = turnText(turn)
    const deltas = turn
      .filter((r) => r.event.type === 'assistant-text' && r.event.delta && !('parentCallId' in r.event && r.event.parentCallId))
      .map((r) => (r.event as { text: string }).text)
      .join('')
    return {
      ...this.stateOf(meta),
      currentTurn: { toolCalls: toolLinesOf(turn), lastText: (finals || deltas).slice(-2000) },
      pending: pendingShape(turn),
      tasks: todoProgress(rows)
    }
  }

  private report(meta: SessionMeta, settled: boolean): ThreadWaitResult {
    const turn = latestTurnRows(this.deps.registry.eventsAfter(meta.id, 0))
    return {
      sessionId: meta.id,
      status: meta.status,
      settled,
      reply: turnText(turn).slice(-CROSS_HOST_REPLY_MAX),
      pending: meta.status === 'waiting' ? pendingShape(turn) : null,
      title: meta.title
    }
  }

  private async wait(sessionId: string, budgetMs: number): Promise<ThreadWaitResult> {
    const now = this.deps.registry.get(sessionId)
    if (!now) throw new Error(`unknown session: ${sessionId}`)
    if (!unsettled(now.status)) return this.report(now, true)
    if (budgetMs <= 0) return this.report(now, false)
    const settledMeta = await waitForSettled(this.deps.registry as SessionRegistry, sessionId, budgetMs)
    const after = this.deps.registry.get(sessionId) ?? now
    return this.report(after, settledMeta !== null && !unsettled(after.status))
  }

  // ── a settle reported back to the box ──────────────────────────────

  private onMeta(meta: SessionMeta): void {
    const owner = this.ownerOf(meta.id)
    if (!owner) return
    const before = this.lastStatus.get(meta.id)
    this.lastStatus.set(meta.id, meta.status)
    if (before === undefined || !unsettled(before) || unsettled(meta.status)) return
    const prior = this.settleTimers.get(meta.id)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.settleTimers.delete(meta.id)
      const latest = this.deps.registry.get(meta.id)
      if (!latest || unsettled(latest.status)) return
      void this.reportSettle(owner, latest)
    }, SETTLE_DEBOUNCE_MS)
    timer.unref()
    this.settleTimers.set(meta.id, timer)
  }

  private async reportSettle(owner: string, meta: SessionMeta): Promise<void> {
    const request = this.deps.link(owner)
    if (!request) return
    const report = this.report(meta, true)
    try {
      await request('crossHost.settled', {
        from: this.deps.environmentId,
        sessionId: meta.id,
        parentSessionId: meta.parentId,
        title: meta.title,
        status: meta.status,
        reply: report.reply.slice(-600),
        pending: report.pending
      })
    } catch (err) {
      // An older box has no crossHost.settled; its wait still sees the state.
      this.log(`${owner}: settle of ${meta.id} not reported (${err instanceof Error ? err.message : String(err)})`)
    }
  }
}

/** The offer this Mac adds to its peer.register: it runs threads for the hosts it links to. */
export const crossHostOffers = (): string[] => [CROSS_HOST_OFFER]
