import { existsSync, readdirSync, statSync } from 'node:fs'
import { LIVE_STATUSES } from '@shared/session-lifecycle'
import { isAbsolute, join } from 'node:path'
import type { ServerPush } from '@shared/contract'
import {
  CROSS_HOST_ATTACHMENTS_MAX,
  CROSS_HOST_CALL_MS,
  CROSS_HOST_DEFAULT_MAX_THREADS,
  CROSS_HOST_MAX_THREADS_CAP,
  CROSS_HOST_MAX_THREADS_PREFIX,
  CROSS_HOST_OFFER,
  CROSS_HOST_REPLY_MAX,
  CROSS_HOST_ROW_TEXT_MAX,
  CrossHostCallerSchema,
  ThreadAdoptArgsSchema,
  ThreadAnswerArgsSchema,
  ThreadArchiveArgsSchema,
  ThreadCheckArgsSchema,
  ThreadEventsArgsSchema,
  ThreadReadArgsSchema,
  ThreadInterruptArgsSchema,
  ThreadListArgsSchema,
  ThreadPauseArgsSchema,
  ThreadSendArgsSchema,
  ThreadSpawnArgsSchema,
  ThreadStartArgsSchema,
  ThreadWaitArgsSchema,
  isCrossHostPeerMethod,
  type CrossHostCallParams,
  type CrossHostCaller,
  type CrossHostLanding,
  type CrossHostLandingResult,
  type CrossHostPeerMethod,
  type CrossHostThreadState,
  type ThreadCheckResult,
  type ThreadEventsResult,
  type ThreadReadResult,
  type ThreadPending,
  type ThreadSpawnArgs,
  type ThreadStartArgs,
  type ThreadStartResult,
  type ThreadWaitResult
} from '@shared/contract-crosshost'
import type { EventRow, SessionMeta, SessionStatus } from '@shared/events'
import type { EnsureLinkedArgs, ProjectLinkFacts } from '@shared/projectLinks'
import type { EnsureLinkedResult } from '@shared/wireSchemas'
import {
  latestTurnRows,
  pendingOf,
  todoProgress,
  toolLinesOf,
  turnText,
  waitForSettled,
  worktreeFor
} from '../orchestration'
import { attachmentDirsOf } from '../attachmentDir'
import { pushBranch as pushBranchToOrigin } from '../mergeBranch'
import { remapper, stripSlash, type HistoryMapping } from '../pathMap'
import type { SessionRegistry } from '../sessions'
import type { HostTransport } from './hostLinks'
import { servePeerCall, type LinkRequest } from './peerCalls'

/**
 * The serving side of threads started from another host (docs/box.md
 * "Threads across hosts"). Another host's thread.* call arrives either as
 * a `peer.call` push on the link this host's main process holds to it (the
 * Mac serving the box, the reverse RPC the Mac bridge uses,
 * remote/peerCalls.ts) or as an ordinary admin request on this host's
 * listener from the socket that host registered (the box serving the Mac);
 * `handle` serves both against this registry exactly as the local app
 * tools would: the thread is an ordinary thread here, listed under this
 * host the moment it is created, with the calling thread's permission.
 *
 *  - Only a saved host may call, and every later call must name a thread
 *    that host started or spawned here (`crossHost.owner.<sessionId>`): a
 *    host never reaches a thread of this host's own or another host's.
 *  - The caller names where it works (its project cwd); this host maps
 *    that onto its own checkout through its path map (the one the harness
 *    sync and the history import share: Mac paths → box paths, read in
 *    both directions, since a Mac path never matches the box side and the
 *    other way round) and the two work roots. When nothing is there, the
 *    thread starts in this host's work root and the result says so.
 *  - A spawned agent carries the calling thread's id as its parentId, so
 *    this host's fleet view shows it under the thread it lists over the
 *    link, and a settle is reported back (`crossHost.settled`, which wakes
 *    the calling thread the way a local child's settle would). A batch
 *    thread's merge_branch here asks its owner before the fast-forward
 *    (`crossHost.landing`): under all-at-once the branch is pushed to
 *    origin and held for the owner's end; otherwise the landing is
 *    reported after the merge so the owner's land step fetches it.
 *  - Admission: the Mac bridge's thread cap when this host has one
 *    (`admit`), else this host's own `crossHost.maxThreads.<envId>`.
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
    | 'list'
  > &
    Partial<Pick<SessionRegistry, 'pauseRun' | 'resumePausedRun' | 'setArchived' | 'setBatchMembership'>>
  /** The saved hosts (remote.environments), by id and name. */
  environments: () => { id: string; name: string }[]
  /** How to send on the link to a host, while it is up: the reply path of a `peer.call` served here. */
  link: (envId: string) => LinkRequest | null
  /** How a report reaches the owner of a thread here, whichever way its socket runs (remote/hostLinks.ts); absent: the link alone. */
  links?: HostTransport
  /** This Mac's path map: its own paths → the box's (remote/harnessSync.ts pathMap). */
  pathMap: () => HistoryMapping
  /** Where this Mac's checkouts live (workRoot.ts). */
  workRoot: () => string
  exists?: (path: string) => boolean
  worktree?: typeof worktreeFor
  log?: (line: string) => void
  /**
   * The Mac bridge's thread cap (macBridge.ts admitThread, `macBridge.maxThreads.<envId>`):
   * asked before every start and spawn with the host's id; a refusal is the
   * tool's error, nothing is queued.
   */
  admit?: (envId: string) => { ok: boolean; reason?: string }
  /** The directories a thread's attachments may sit in (attachmentDir.ts); tests pass their own. */
  attachmentDirs?: (meta: SessionMeta) => string[]
  /** Push a branch to origin before it is held for the owner's end (mergeBranch.ts). */
  pushBranch?: (cwd: string, branch: string) => Promise<void>
  /**
   * Find or create this host's copy of the caller's project (projectLinks.ts
   * `ensureLinked`): a start that carries the caller's project facts lands in
   * that copy. Absent, or no copy: the path logic decides as before.
   */
  ensureLinked?: (args: EnsureLinkedArgs) => Promise<EnsureLinkedResult>
  /** A thread's digest and project name for thread.read (mirror.ts cappedThreadDigest); absent: thread.read is refused. */
  digest?: (meta: SessionMeta) => { digest: string; projectName: string | null }
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

/**
 * A Mac path on the box: the map's own direction (Mac sources → box
 * destinations, longest first), else `<boxWorkRoot>/<rest>` under this
 * host's work root, else nothing. The mirror of macPathFor.
 */
export function boxPathFor(
  macPath: string,
  mapping: HistoryMapping,
  boxWorkRoot: string,
  macWorkRoot?: string
): string | null {
  if (!isAbsolute(macPath)) return null
  const clean = stripSlash(macPath)
  const mapped = remapper(mapping).path(clean)
  if (mapped !== clean) return mapped
  if (macWorkRoot) {
    const root = stripSlash(macWorkRoot)
    const under = clean === root || clean.startsWith(root === '/' ? '/' : root + '/')
    if (root !== '/' && under) return join(stripSlash(boxWorkRoot), clean.slice(root.length))
  }
  return null
}

/**
 * Where a caller's path lands on this host: the inverse map (a box path
 * on the Mac), else the forward map (a Mac path on the box), else the
 * work-root fallback, the first that exists; null when none does. A path
 * matches only its own side of the map, so both directions are safe to try.
 */
export function hostPathFor(
  callerPath: string,
  mapping: HistoryMapping,
  myWorkRoot: string,
  callerWorkRoot: string | undefined,
  exists: (path: string) => boolean
): { path: string; exists: boolean } | null {
  const candidates = [
    macPathFor(callerPath, mapping, myWorkRoot, callerWorkRoot),
    boxPathFor(callerPath, mapping, myWorkRoot, callerWorkRoot)
  ].filter((p): p is string => !!p)
  if (!candidates.length) return null
  const found = candidates.find((p) => exists(p))
  return found ? { path: stripSlash(found), exists: true } : { path: candidates[0], exists: false }
}

/** The files under a thread's attachment directories, relative to none (absolute), newest last, capped. */
export function listAttachments(dirs: readonly string[], max = CROSS_HOST_ATTACHMENTS_MAX): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > 4) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (out.length >= max) return
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (st.isDirectory()) walk(path, depth + 1)
        else if (st.isFile() && !name.startsWith('.')) out.push(path)
      } catch {
        /* gone */
      }
    }
  }
  for (const dir of dirs) walk(dir, 0)
  return out
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

  /** Threads a host started here that are live now: what the Mac bridge's thread cap counts. */
  liveThreadsOf(envId: string): number {
    return this.deps.registry
      .list()
      .filter((m) => LIVE_STATUSES.has(m.status) && this.ownerOf(m.id) === envId).length
  }

  /** Threads a host may have live here at once when this host has no Mac bridge cap: `crossHost.maxThreads.<envId>`, default 4. */
  maxThreadsOf(envId: string): number {
    const raw = this.deps.store.getSetting(`${CROSS_HOST_MAX_THREADS_PREFIX}${envId}`)
    const n = raw === null ? NaN : Number(raw)
    if (!Number.isInteger(n) || n < 0) return CROSS_HOST_DEFAULT_MAX_THREADS
    return Math.min(n, CROSS_HOST_MAX_THREADS_CAP)
  }

  /** The thread cap, before a start or spawn: the Mac bridge's when given, else this host's own. */
  admitThread(envId: string): { ok: boolean; reason?: string } {
    if (this.deps.admit) return this.deps.admit(envId)
    const max = this.maxThreadsOf(envId)
    const live = this.liveThreadsOf(envId)
    if (live < max) return { ok: true }
    const name = this.deps.environments().find((e) => e.id === envId)?.name ?? envId
    return { ok: false, reason: `this host runs ${live} of at most ${max} threads for ${name} already (crossHost.maxThreads.${envId}); wait for one to finish and retry, never start the work on your own host instead` }
  }

  private admitted(caller: CrossHostCaller): void {
    const verdict = this.admitThread(caller.environmentId)
    if (!verdict.ok) throw new Error(verdict.reason ?? 'this host takes no more threads from that host right now')
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

  /**
   * A thread.* request on this host's listener (the Mac asking the box over
   * its own link): served by the same handler, the caller being the
   * environment the socket registered as.
   */
  handleRequest(method: string, params: unknown, from: string | null): Promise<unknown> | null {
    if (!isCrossHostPeerMethod(method)) return null
    if (!from) return Promise.reject(new Error(`${method} needs a registered peer: send peer.register on this socket first`))
    return this.handle(method, params as CrossHostCallParams, { from, deadlineAt: Date.now() + CROSS_HOST_CALL_MS })
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
        const dirs = (this.deps.attachmentDirs ?? ((m: SessionMeta) => attachmentDirsOf(m)))(meta)
        const result: ThreadEventsResult = {
          sessionId: a.sessionId,
          rows: rows.map((r) => ({ seq: r.seq, ts: r.ts, event: trimEvent(r.event as unknown as Record<string, unknown>) })),
          lastSeq: all.length ? all[all.length - 1].seq : (a.afterSeq ?? 0),
          status: meta.status,
          attachments: listAttachments(dirs)
        }
        return result
      }
      case 'thread.read': {
        // A reference the person picked: any thread here, owned or not.
        const a = ThreadReadArgsSchema.parse(args)
        const meta = this.deps.registry.get(a.sessionId)
        if (!meta) throw new Error(`unknown thread: ${a.sessionId}`)
        if (!this.deps.digest) throw new Error('this host cannot read threads over the link')
        const { digest, projectName } = this.deps.digest(meta)
        line(`read ${a.sessionId}`)
        const result: ThreadReadResult = { sessionId: meta.id, title: meta.title, projectName, digest }
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
      case 'thread.pause': {
        const a = ThreadPauseArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        if (!this.deps.registry.pauseRun) throw new Error('this host cannot pause threads over the link')
        await this.deps.registry.pauseRun(a.sessionId)
        line(`paused ${a.sessionId}`)
        return { ok: true }
      }
      case 'thread.resume': {
        const a = ThreadPauseArgsSchema.parse(args)
        this.own(caller, a.sessionId)
        if (!this.deps.registry.resumePausedRun) throw new Error('this host cannot resume threads over the link')
        await this.deps.registry.resumePausedRun(a.sessionId)
        line(`resumed ${a.sessionId}`)
        return { ok: true }
      }
      case 'thread.archive': {
        const a = ThreadArchiveArgsSchema.parse(args)
        const meta = this.own(caller, a.sessionId)
        if (!this.deps.registry.setArchived) throw new Error('this host cannot archive threads over the link')
        // setArchived stops a live thread's tree first, as the fleet's archive does.
        await this.deps.registry.setArchived(meta.id, true)
        line(`archived ${a.sessionId}`)
        return { ok: true }
      }
      case 'thread.adopt': {
        const a = ThreadAdoptArgsSchema.parse(args)
        const meta = this.deps.registry.get(a.sessionId)
        const owner = this.ownerOf(a.sessionId)
        const why = !meta
          ? 'unknown thread'
          : meta.parentId
            ? 'it is a subagent'
            : meta.isMaster
              ? 'it is a master thread'
              : meta.archived
                ? 'it is archived'
                : meta.masterId && meta.masterId !== a.masterId
                  ? `it is in the batch of ${meta.masterId}`
                  : owner && owner !== caller.environmentId
                    ? `it belongs to a thread on ${this.deps.environments().find((e) => e.id === owner)?.name ?? owner}`
                    : null
        if (why) throw new Error(why)
        if (!this.deps.registry.setBatchMembership) throw new Error('this host cannot adopt threads over the link')
        if (meta!.masterId !== a.masterId) this.deps.registry.setBatchMembership(a.sessionId, a.masterId)
        this.remember(caller, a.sessionId)
        this.lastStatus.set(a.sessionId, meta!.status)
        line(`adopted ${a.sessionId} into the batch of ${a.masterId}`)
        return { ok: true, ...this.stateOf(this.deps.registry.get(a.sessionId) ?? meta!) }
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

  /** The caller's path on this host, when a mapping names one (whether or not it exists). */
  private mapPath(callerPath: string, callerWorkRoot?: string): string | null {
    const exists = this.deps.exists ?? isDir
    return hostPathFor(callerPath, this.deps.pathMap(), stripSlash(this.deps.workRoot()), callerWorkRoot, exists)?.path ?? null
  }

  /**
   * Where a thread for a caller works here, and the project that is: the
   * linked copy of the caller's project when the call carries its facts
   * (created here when this host has the workspace and no copy yet), else
   * the caller's path mapped onto a checkout here, else the work root.
   */
  private async place(
    callerCwd: string,
    callerWorkRoot: string | undefined,
    project: ProjectLinkFacts | undefined
  ): Promise<{ cwd: string; projectId: string | null; cwdNote?: string }> {
    if (project && this.deps.ensureLinked) {
      try {
        const copy = await this.deps.ensureLinked({
          projectLinkId: project.linkId,
          workspaceLinkId: project.workspaceLinkId,
          name: project.name,
          branch: project.branch,
          mode: project.mode,
          callerWorkspacePath: project.workspacePath,
          callerProjectCwd: project.cwd,
          ...(callerWorkRoot ? { callerWorkRoot } : {}),
          ...(project.workspaceGithubRepo ? { workspaceGithubRepo: project.workspaceGithubRepo } : {})
        })
        if (copy.cwd && copy.project) return { cwd: copy.cwd, projectId: copy.project.id, ...(copy.note ? { cwdNote: copy.note } : {}) }
      } catch (err) {
        this.deps.log?.(`[crossHost] no linked copy of ${project.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return this.placeByPath(callerCwd, callerWorkRoot)
  }

  /** Where a thread for a caller's path works here, and the project that is, if any. */
  private placeByPath(callerCwd: string, callerWorkRoot?: string): { cwd: string; projectId: string | null; cwdNote?: string } {
    const exists = this.deps.exists ?? isDir
    const root = stripSlash(this.deps.workRoot())
    const mapped = hostPathFor(callerCwd, this.deps.pathMap(), root, callerWorkRoot, exists)
    const cwd = mapped?.exists ? mapped.path : null
    const projectOf = (path: string): string | null =>
      this.deps.registry.listProjects().find((p) => stripSlash(p.cwd) === path)?.id ?? null
    if (cwd) return { cwd, projectId: projectOf(cwd) }
    return {
      cwd: root,
      projectId: projectOf(root),
      cwdNote: `this host has no checkout for ${callerCwd}${mapped ? ` (looked for ${mapped.path})` : ''}; the thread starts in its work root ${root}`
    }
  }

  private async start(caller: CrossHostCaller, args: ThreadStartArgs): Promise<ThreadStartResult> {
    // Admission first: a refused start creates no copy of the project here.
    this.admitted(caller)
    const placed = await this.place(args.cwd, args.workRoot, args.project)
    const planPath =
      args.planPath && (args.threadType === 'implementation' || args.threadType === 'orchestration')
        ? (this.mapPath(args.planPath, args.workRoot) ?? undefined)
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
      // The box thread started it, and its batch comes along (the ids are
      // the box's; this host reports to neither, the box supervises).
      startedBy: caller.sessionId,
      ...(args.masterId ? { masterId: args.masterId } : {}),
      cwd: placed.cwd
    })
    this.remember(caller, thread.id)
    this.lastStatus.set(thread.id, thread.status)
    await this.deps.registry.send(thread.id, args.firstMessage)
    const created = this.deps.registry.get(thread.id) ?? thread
    return { sessionId: thread.id, title: created.title, cwd: placed.cwd, projectId: placed.projectId, ...(placed.cwdNote ? { cwdNote: placed.cwdNote } : {}) }
  }

  private async spawn(caller: CrossHostCaller, args: ThreadSpawnArgs): Promise<ThreadStartResult> {
    this.admitted(caller)
    const placed = await this.place(args.cwd, args.workRoot, args.project)
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
    await this.deps.registry.send(child.id, args.task, { preamble: args.preamble !== false })
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

  /** One report to the owner of a thread here, whichever way its socket runs. */
  private reportTo<T>(owner: string, method: 'crossHost.settled' | 'crossHost.landing', params: unknown): Promise<T> {
    if (this.deps.links) return this.deps.links.call<T>(owner, method, params, CROSS_HOST_CALL_MS)
    const request = this.deps.link(owner)
    if (!request) return Promise.reject(new Error(`${owner} is not linked`))
    return request(method, params, { timeoutMs: CROSS_HOST_CALL_MS }) as Promise<T>
  }

  private async reportSettle(owner: string, meta: SessionMeta): Promise<void> {
    const report = this.report(meta, true)
    try {
      await this.reportTo(owner, 'crossHost.settled', {
        from: this.deps.environmentId,
        sessionId: meta.id,
        // The thread that spawned it, else the one that started it: the owner's record sits under that thread.
        parentSessionId: meta.parentId ?? meta.startedBy ?? null,
        title: meta.title,
        status: meta.status,
        reply: report.reply.slice(-600),
        pending: report.pending
      })
    } catch (err) {
      // An older host has no crossHost.settled, or the link is down; a wait still sees the state.
      this.log(`${owner}: settle of ${meta.id} not reported (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  // ── a batch thread here landing (merge_branch on this host) ────────

  /** True when a thread here belongs to another host's batch: its owner decides its landing. */
  private remoteBatchOwner(session: SessionMeta): string | null {
    const owner = this.ownerOf(session.id)
    return owner && session.masterId ? owner : null
  }

  /**
   * merge_branch's hold hook for a thread of another host's batch: the
   * branch goes to origin first, then the owner is asked; under
   * all-at-once the answer is the HELD text the thread reads, else null
   * (merge now). A local thread answers null (the local engine decides).
   * An owner out of reach refuses the merge rather than landing blind.
   */
  async landingHold(session: SessionMeta, landing: { cwd: string; branch: string; target: string; subjects: string[] }): Promise<string | null> {
    const owner = this.remoteBatchOwner(session)
    if (!owner) return null
    await (this.deps.pushBranch ?? pushBranchToOrigin)(landing.cwd, landing.branch)
    const params: CrossHostLanding = {
      from: this.deps.environmentId,
      sessionId: session.id,
      masterId: session.masterId!,
      phase: 'ask',
      branch: landing.branch,
      target: landing.target,
      subjects: landing.subjects
    }
    let verdict: CrossHostLandingResult
    try {
      verdict = await this.reportTo<CrossHostLandingResult>(owner, 'crossHost.landing', params)
    } catch (err) {
      throw new Error(`the master's host (${this.deps.environments().find((e) => e.id === owner)?.name ?? owner}) could not be asked about this landing: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!verdict.hold) return null
    this.log(`${owner}: ${landing.branch} of ${session.id} held for the batch's end (pushed to origin)`)
    return `HELD: the batch lands all at once; the master (on ${this.deps.environments().find((e) => e.id === owner)?.name ?? owner}) will merge ${landing.branch} from origin when every thread is done. Your work is recorded; you are done with it.`
  }

  /** merge_branch's landed hook for a thread of another host's batch: the owner's land step counts it and fetches origin. */
  landingDone(session: SessionMeta, landed: { branch: string; target: string; sha: string; subjects: string[] }): boolean {
    const owner = this.remoteBatchOwner(session)
    if (!owner) return false
    const params: CrossHostLanding = {
      from: this.deps.environmentId,
      sessionId: session.id,
      masterId: session.masterId!,
      phase: 'landed',
      branch: landed.branch,
      target: landed.target,
      subjects: landed.subjects,
      sha: landed.sha
    }
    void this.reportTo(owner, 'crossHost.landing', params).catch((err: unknown) => {
      this.log(`${owner}: landing of ${session.id} not reported (${err instanceof Error ? err.message : String(err)})`)
    })
    return true
  }
}

/** The offer this Mac adds to its peer.register: it runs threads for the hosts it links to. */
export const crossHostOffers = (): string[] => [CROSS_HOST_OFFER]
