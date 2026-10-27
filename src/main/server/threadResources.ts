import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import type { ThreadResource, ThreadResourceKind, ThreadResourceRemoval } from '@shared/contract-resources'
import type { MacRunResult } from '@shared/contract-macbridge'
import type { MacJobReadResult } from '@shared/contract-macjobs'
import type { EventRow, SessionMeta } from '@shared/events'
import { detectCommand, detectHarnessWorktree, shellOf, type Created, type Detected, type Removed } from './threadResourcesParse'
import { removeResource, type ResourceRunner, type RunResult } from './threadResourcesRemove'

/**
 * The ledger of what a thread created (docs/box.md "Thread resources"):
 * git worktrees, simulators and isolated dev instances, on this host or on
 * the Mac through the bridge. Rows are filed under the top-level thread
 * (a subagent's resources are its parent's) with the environment id of the
 * host they live on. Three feeds write it: the session event stream (a
 * Bash-like tool-call paired with its tool-result, and the harness's
 * EnterWorktree/ExitWorktree), a mac.run's result on the box, and a mac.run
 * job's reads. Removal runs on the owning host (threadResourcesRemove.ts
 * says how): this host runs the commands itself, a Mac runs them through
 * the bridge as the thread with the thread's permission, and a host that is
 * offline leaves the row waiting with remove_requested_at set until a
 * link-up retries it. Nothing outside the ledger is ever touched.
 */

interface Row {
  id: string
  session_id: string
  environment_id: string
  kind: ThreadResourceKind
  identifier: string
  label: string
  branch: string | null
  created_at: number
  remove_requested_at: number | null
  removed_at: number | null
  note: string | null
  pid: number | null
  call_id: string | null
  what: string | null
}

const toResource = (r: Row): ThreadResource => ({
  ...(r.kind === 'port' ? { pid: r.pid, callId: r.call_id, what: r.what ?? null } : {}),
  id: r.id,
  sessionId: r.session_id,
  environmentId: r.environment_id,
  kind: r.kind,
  identifier: r.identifier,
  label: r.label,
  branch: r.branch,
  createdAt: r.created_at,
  removeRequestedAt: r.remove_requested_at,
  removedAt: r.removed_at,
  note: r.note
})

/** Tool-calls kept per session until their result arrives (only shell-like and worktree tools). */
const PENDING_CALLS_MAX = 64

export interface ThreadResourcesDeps {
  db: DatabaseSync
  /** This host's environment id: where a local tool call's resources live. */
  environmentId: string
  sessions: { get(id: string): SessionMeta | null | undefined }
  /** Run a command on a host: this one directly, a Mac over the bridge as the thread. Rejects with `offline: true` when the host has no link. */
  runOn: (environmentId: string, thread: SessionMeta, argv: string[], cwd: string) => Promise<RunResult>
  /** The home of a host, for `~` in its commands (this host's by default). */
  homeOf?: (environmentId: string) => string | null
  now?: () => number
  log?: (line: string) => void
}

export class OfflineError extends Error {
  readonly offline = true as const
  constructor(envId: string) {
    super(`host offline: ${envId}`)
    this.name = 'OfflineError'
  }
}

export class ThreadResources {
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly pending = new Map<string, Map<string, { name: string; input: unknown }>>()
  private readonly jobs = new Map<string, { sessionId: string; macPeer: string; argv?: string[]; command?: string; cwd: string; home: string; output: string; recorded: boolean }>()
  private readonly listeners = new Set<(sessionId: string, resources: ThreadResource[]) => void>()
  private readonly removing = new Set<string>()

  constructor(private readonly deps: ThreadResourcesDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[resources] ${line}`))
  }

  /** The thread's rows change (a record, a removal, a wait): the listener gets the thread's current list. */
  onChange(listener: (sessionId: string, resources: ThreadResource[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Adds what the ledger does not keep to a row on its way out: a port's forwards (portForward.ts). */
  decorate: ((r: ThreadResource) => ThreadResource) | null = null

  /** Something outside the ledger changed a thread's rows (a forward landed): its listeners hear the list again. */
  notify(sessionId: string): void {
    this.changed(sessionId)
  }

  private out(rows: Row[]): ThreadResource[] {
    const d = this.decorate
    return d ? rows.map((r) => d(toResource(r))) : rows.map(toResource)
  }

  private changed(sessionId: string): void {
    if (!this.listeners.size) return
    const rows = this.list(sessionId, true)
    for (const l of this.listeners) l(sessionId, rows)
  }

  // ── reading ──────────────────────────────────────────────────────────

  list(sessionId: string, includeRemoved = false): ThreadResource[] {
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM thread_resources WHERE session_id = ? ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY created_at DESC, id DESC`
      )
      .all(sessionId) as unknown as Row[]
    return this.out(rows)
  }

  /** Every live row on this ledger, any thread (a device list joins on it). */
  listAll(filter: { kind?: ThreadResourceKind; environmentId?: string } = {}): ThreadResource[] {
    const rows = this.deps.db
      .prepare(`SELECT * FROM thread_resources WHERE removed_at IS NULL ORDER BY created_at DESC, id DESC`)
      .all() as unknown as Row[]
    return this.out(
      rows.filter((r) => (!filter.kind || r.kind === filter.kind) && (!filter.environmentId || r.environment_id === filter.environmentId))
    )
  }

  get(id: string): ThreadResource | null {
    const row = this.deps.db.prepare(`SELECT * FROM thread_resources WHERE id = ?`).get(id) as Row | undefined
    return row ? toResource(row) : null
  }

  /** Live rows on a host whose removal was asked for while it was offline. */
  waitingOn(environmentId: string): ThreadResource[] {
    const rows = this.deps.db
      .prepare(`SELECT * FROM thread_resources WHERE environment_id = ? AND removed_at IS NULL AND remove_requested_at IS NOT NULL ORDER BY remove_requested_at`)
      .all(environmentId) as unknown as Row[]
    return rows.map(toResource)
  }

  // ── recording ────────────────────────────────────────────────────────

  /** The top-level thread a session's resources are filed under. */
  ownerOf(sessionId: string): string {
    let id = sessionId
    for (let d = 0; d < 32; d++) {
      const parent = this.deps.sessions.get(id)?.parentId
      if (!parent) break
      id = parent
    }
    return id
  }

  /** Record what a command on `environmentId` created; a resource already live there stays with its first owner. */
  record(sessionId: string, environmentId: string, detected: Detected): ThreadResource[] {
    const owner = this.ownerOf(sessionId)
    const made: ThreadResource[] = []
    for (const c of detected.created) {
      const id = `r${randomBytes(9).toString('base64url')}`
      const r = this.deps.db
        .prepare(
          `INSERT OR IGNORE INTO thread_resources (id, session_id, environment_id, kind, identifier, label, branch, created_at, pid, call_id, what)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, owner, environmentId, c.kind, c.identifier, c.label, c.branch, this.now(), c.pid ?? null, c.callId ?? null, c.what ?? null)
      if (r.changes > 0) {
        made.push(this.get(id) as ThreadResource)
        this.log(`thread=${owner}${owner !== sessionId ? ` (via ${sessionId})` : ''} ${c.kind} ${c.identifier} on ${environmentId}`)
      }
    }
    const gone = this.markRemoved(environmentId, detected.removed, 'removed by the thread')
    if (made.length || gone) this.changed(owner)
    return made
  }

  /** The live row of a resource on a host, whoever owns it. */
  live(environmentId: string, kind: ThreadResourceKind, identifier: string): ThreadResource | null {
    const row = this.deps.db
      .prepare(`SELECT * FROM thread_resources WHERE environment_id = ? AND kind = ? AND identifier = ? AND removed_at IS NULL`)
      .get(environmentId, kind, identifier) as Row | undefined
    return row ? toResource(row) : null
  }

  /** A resource ended on its own (a port stopped listening): its live row is stamped with the note. */
  ended(environmentId: string, kind: ThreadResourceKind, identifier: string, note: string): number {
    return this.markRemoved(environmentId, [{ kind, identifier }], note)
  }

  /** A port's listener changed hands (a watcher restarted the server): the row follows the new pid. */
  setPid(id: string, pid: number): void {
    this.deps.db.prepare(`UPDATE thread_resources SET pid = ? WHERE id = ? AND removed_at IS NULL`).run(pid, id)
    const row = this.get(id)
    if (row) this.changed(row.sessionId)
  }

  /** The thread (or the harness) removed it itself: the live row is stamped, whoever owns it. */
  private markRemoved(environmentId: string, removed: readonly Removed[], note: string): number {
    let n = 0
    const owners = new Set<string>()
    for (const r of removed) {
      const rows = this.deps.db
        .prepare(
          `SELECT * FROM thread_resources WHERE environment_id = ? AND kind = ? AND removed_at IS NULL AND (identifier = ? OR (kind = 'simulator' AND label = ?))`
        )
        .all(environmentId, r.kind, r.identifier, r.identifier) as unknown as Row[]
      for (const row of rows) {
        this.deps.db.prepare(`UPDATE thread_resources SET removed_at = ?, note = ? WHERE id = ?`).run(this.now(), note, row.id)
        owners.add(row.session_id)
        n++
      }
    }
    for (const o of owners) this.changed(o)
    return n
  }

  /** The session event stream: a shell-like tool-call paired with its result, and the harness's worktree tools. */
  observeEvent(row: EventRow): void {
    const ev = row.event
    if (ev.type === 'tool-call') {
      if (ev.partial) return
      const worktreeTool = ev.name === 'EnterWorktree' || ev.name === 'ExitWorktree'
      if (!worktreeTool && !shellOf(ev.input)) return
      let calls = this.pending.get(row.sessionId)
      if (!calls) this.pending.set(row.sessionId, (calls = new Map()))
      calls.delete(ev.callId)
      calls.set(ev.callId, { name: ev.name, input: ev.input })
      while (calls.size > PENDING_CALLS_MAX) calls.delete(calls.keys().next().value as string)
      return
    }
    if (ev.type !== 'tool-result') return
    const calls = this.pending.get(row.sessionId)
    const call = calls?.get(ev.callId)
    if (!call) return
    calls!.delete(ev.callId)
    if (!calls!.size) this.pending.delete(row.sessionId)
    const session = this.deps.sessions.get(row.sessionId)
    if (!session) return
    const home = this.deps.homeOf?.(this.deps.environmentId) ?? homedir()
    let detected: Detected
    if (call.name === 'EnterWorktree' || call.name === 'ExitWorktree') detected = detectHarnessWorktree(call.name, call.input, ev.output)
    else {
      const shell = shellOf(call.input)
      if (!shell) return
      detected = detectCommand({ ...shell, cwd: shell.cwd ?? session.cwd, home, output: ev.output })
    }
    if (detected.created.length || detected.removed.length) this.record(row.sessionId, this.deps.environmentId, detected)
  }

  /** A mac.run the box sent and the Mac answered: the resource lives on the Mac. */
  observeMacRun(
    sessionId: string,
    macPeer: string,
    args: { argv?: string[]; command?: string; cwd?: string },
    result: MacRunResult,
    macHome: string
  ): void {
    const detected = detectCommand({
      ...(args.argv ? { argv: args.argv } : {}),
      ...(args.command ? { command: args.command } : {}),
      cwd: args.cwd ? expandHome(args.cwd, macHome) : macHome,
      home: macHome,
      output: `${result.stdout}\n${result.stderr}`,
      exitCode: result.exitCode
    })
    if (detected.created.length || detected.removed.length) this.record(sessionId, macPeer, detected)
  }

  /** A mac.run job started: its command is kept until its reads show what it made. */
  observeJobStart(sessionId: string, macPeer: string, jobId: string, args: { argv?: string[]; command?: string; cwd?: string }, macHome: string): void {
    this.jobs.set(jobId, {
      sessionId,
      macPeer,
      ...(args.argv ? { argv: args.argv } : {}),
      ...(args.command ? { command: args.command } : {}),
      cwd: args.cwd ? expandHome(args.cwd, macHome) : macHome,
      home: macHome,
      output: '',
      recorded: false
    })
    if (this.jobs.size > 256) this.jobs.delete(this.jobs.keys().next().value as string)
  }

  /** A read of a job's output: once the output proves a creation the row lands (once per job). */
  observeJobRead(jobId: string, result: Pick<MacJobReadResult, 'output' | 'running' | 'exitCode'>): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.output = (job.output + result.output).slice(-64 * 1024)
    if (!job.recorded) {
      const detected = detectCommand({
        ...(job.argv ? { argv: job.argv } : {}),
        ...(job.command ? { command: job.command } : {}),
        cwd: job.cwd,
        home: job.home,
        output: job.output,
        // A job still running has no exit code; its own lines decide. A finished one is judged by it.
        ...(result.running ? {} : { exitCode: result.exitCode })
      })
      if (detected.created.length || detected.removed.length) {
        this.record(job.sessionId, job.macPeer, detected)
        job.recorded = true
      }
    }
    if (!result.running) this.jobs.delete(jobId)
  }

  // ── removal ──────────────────────────────────────────────────────────

  /** Remove the named rows (default: every live row of the thread) on their hosts. */
  async remove(sessionId: string, ids?: readonly string[]): Promise<ThreadResourceRemoval[]> {
    const owner = this.ownerOf(sessionId)
    const live = this.list(owner).filter((r) => !ids || ids.includes(r.id))
    const results: ThreadResourceRemoval[] = []
    for (const row of live) results.push(await this.removeOne(row))
    return results
  }

  /** How many live rows a thread has, by host: what the archive confirm says. */
  summary(sessionId: string): { total: number; byHost: Record<string, number> } {
    const byHost: Record<string, number> = {}
    const rows = this.list(this.ownerOf(sessionId))
    for (const r of rows) byHost[r.environmentId] = (byHost[r.environmentId] ?? 0) + 1
    return { total: rows.length, byHost }
  }

  private async removeOne(row: ThreadResource): Promise<ThreadResourceRemoval> {
    if (this.removing.has(row.id)) return { id: row.id, outcome: 'waiting', note: 'removal already running' }
    const thread = this.deps.sessions.get(row.sessionId)
    if (!thread) {
      // The thread is gone from this host (deleted): nothing can run as it; the row stays live, noted.
      this.stamp(row.id, { note: 'its thread is gone; remove by hand' })
      return { id: row.id, outcome: 'failed', note: 'its thread is gone; remove by hand' }
    }
    this.removing.add(row.id)
    this.stamp(row.id, { removeRequestedAt: this.now(), note: null })
    try {
      const runner: ResourceRunner = (argv, cwd) => this.deps.runOn(row.environmentId, thread, argv, cwd)
      const outcome = await removeResource(row, runner)
      this.stamp(row.id, { removedAt: this.now(), note: outcome.note })
      this.log(`thread=${row.sessionId} removed ${row.kind} ${row.identifier} on ${row.environmentId}${outcome.note ? ` (${outcome.note})` : ''}`)
      return { id: row.id, outcome: 'removed', note: outcome.note }
    } catch (e) {
      const offline = !!(e as { offline?: boolean })?.offline
      const note = offline ? 'host offline, waiting for its link' : (e instanceof Error ? e.message : String(e))
      if (offline) this.stamp(row.id, { note })
      else this.stamp(row.id, { removeRequestedAt: null, note })
      this.log(`thread=${row.sessionId} ${row.kind} ${row.identifier} on ${row.environmentId}: ${note}`)
      return { id: row.id, outcome: offline ? 'waiting' : 'failed', note }
    } finally {
      this.removing.delete(row.id)
    }
  }

  private stamp(id: string, patch: { removeRequestedAt?: number | null; removedAt?: number | null; note?: string | null }): void {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    if ('removeRequestedAt' in patch) sets.push('remove_requested_at = ?'), values.push(patch.removeRequestedAt ?? null)
    if ('removedAt' in patch) sets.push('removed_at = ?'), values.push(patch.removedAt ?? null)
    if ('note' in patch) sets.push('note = ?'), values.push(patch.note ?? null)
    if (!sets.length) return
    this.deps.db.prepare(`UPDATE thread_resources SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    const row = this.get(id)
    if (row) this.changed(row.sessionId)
  }

  /** A host's link came up: every row waiting on it is retried, in order. */
  async linkUp(environmentId: string): Promise<void> {
    const waiting = this.waitingOn(environmentId)
    if (!waiting.length) return
    this.log(`${environmentId} linked: retrying ${waiting.length} waiting removal${waiting.length === 1 ? '' : 's'}`)
    for (const row of waiting) await this.removeOne(row)
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  return path
}

export type { Created, Detected, Removed }
