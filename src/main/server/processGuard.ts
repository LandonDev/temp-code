import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { EventRow } from '@shared/events'
import { parseEnviron } from './portSweep'

/**
 * The process guard: an agent's tool processes never outlive their call,
 * never run on with no parent, and never take the host's memory.
 *
 * On 2026-10-27 a test run left 22 vitest workers behind (tinypool children
 * of a `bunx vitest` whose shell had been killed), parent gone, 62 GB
 * between them; the box swapped and answered nothing for ten hours. Three
 * rules, all on the host:
 *
 *  1. A call's processes. The claude harness runs every Bash call in a
 *     shell of its own session (the shell is its own process group and
 *     session leader), so what the host needs is the identity: the driver's
 *     PreToolUse hook prefixes the command with `wrapBashCommand`, which
 *     exports `TEMP_CODE_THREAD` and `TEMP_CODE_CALL` into the call's shell,
 *     and every descendant inherits them. No `setsid` (the shell already is
 *     one) and no `exec` (the harness appends its own cwd tracking after the
 *     command). When the call ends (its result came back, it timed out, the
 *     turn stopped or the harness went) the host SIGTERMs what still
 *     carries the call's mark, whole groups where the group is the call's
 *     own, then SIGKILLs what is left at the next sweep after KILL_GRACE_MS;
 *     never a harness, never a pid the ledger knows (a `port` row's dev
 *     server), and never a call the thread backgrounded on purpose
 *     (`run_in_background`, or a live background task the harness lists).
 *     Only a thread in full access carries the call mark: a prompting
 *     thread's permission rules match the command as written, so its calls
 *     carry the thread's marks alone.
 *  2. The orphan sweep. Every tick, any process of this user whose parent
 *     is gone (ppid 1) that carries a thread's mark in its environment
 *     (`TEMP_CODE_THREAD`, the gateway's `~t=` scope in ANTHROPIC_BASE_URL,
 *     or CLAUDE_PID) and is not a ledger-known server or a backgrounded
 *     call's is killed once it has been orphaned for ORPHAN_GRACE_MS, with
 *     one log line naming the thread, the command and its RSS.
 *  3. The memory cap. A call's processes whose RSS together passes the cap
 *     (the `tools.memoryCapMb` setting, 8 GiB by default) are killed and
 *     the call's tool result says so (`tail`). RSS is the per-process
 *     reading admission.ts samples the harnesses with, the same `ps` column.
 *
 * Everything here reads one `ps` per tick (shared for a second) and a
 * process's environment once (`/proc/<pid>/environ` on Linux, `ps -E` on
 * macOS, which has no /proc); the deps are injectable so the rules run over
 * fake trees in processGuard.test.ts.
 */

export interface GuardProc {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
  args: string
}

export interface GuardMarkers {
  threadId: string | null
  callId: string | null
}

export interface ProcessGuardDeps {
  /** This user's processes, one row each. */
  scan(): Promise<GuardProc[]>
  /** A process's NUL-separated environment, null when it cannot be read; `args` is its command line as the scan saw it (macOS strips it off `ps -E`'s line). */
  environ(pid: number, args?: string): Promise<string | null>
  /** Send a signal; a negative pid is a process group. False when nothing was there. */
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean
  /** Pids the ledger knows as deliberately backgrounded (the `port` rows). */
  ledgerPids(): Set<number>
  /** The calls of a thread the harness lists as live background tasks (never killed at call end). */
  backgroundCalls(threadId: string): Set<string>
  /** The harness processes themselves: never a target, never a group to kill. */
  harnessPids(): Set<number>
  /** The thread a harness pid belongs to, for a process marked by CLAUDE_PID alone. */
  threadOfHarness?(pid: number): string | null
  /** The per-call RSS cap in bytes (the setting, else DEFAULT_CALL_CAP_BYTES). */
  capBytes(): number
  now?: () => number
  log?: (line: string) => void
  ownPid?: number
}

export const THREAD_MARK = 'TEMP_CODE_THREAD'
export const CALL_MARK = 'TEMP_CODE_CALL'
export const GUARD_TICK_MS = 10_000
export const ORPHAN_GRACE_MS = 60_000
export const KILL_GRACE_MS = 5_000
export const DEFAULT_CALL_CAP_BYTES = 8 * 1024 * 1024 * 1024
export const MEMORY_CAP_SETTING = 'tools.memoryCapMb'
/** The tool-result line when the cap killed the call's processes. */
export const CAP_LINE_PREFIX = "The host killed this command's processes"
/** One `ps` serves every reader inside this window. */
const SCAN_SHARE_MS = 1_000

const SETTLE_STATUSES = new Set(['idle', 'error', 'stopped', 'done'])

/** `'…'` for bash: single-quoted, with embedded single quotes closed, escaped and reopened. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * The command a Bash call runs, marked: the thread and the call exported
 * into the call's shell, so every process of the call carries them and the
 * host can end them, sweep them and weigh them. The command itself runs as
 * written after the marks.
 */
export function wrapBashCommand(command: string, callId: string, threadId: string): string {
  return `export ${THREAD_MARK}=${shellQuote(threadId)} ${CALL_MARK}=${shellQuote(callId)}; ${command}`
}

const WRAP_PREFIX = new RegExp(`^export ${THREAD_MARK}='(?:[^']|'\\\\'')*' ${CALL_MARK}='(?:[^']|'\\\\'')*'; `)

/** The command as the model wrote it (the approval card shows this, never the marks). */
export function unwrapBashCommand(command: string): string {
  return command.replace(WRAP_PREFIX, '')
}

/** The thread and the call a process belongs to, read off its environment. */
export function markersOf(environ: string | null): GuardMarkers & { claudePid: number | null } {
  if (!environ) return { threadId: null, callId: null, claudePid: null }
  const base = parseEnviron(environ)
  let threadId = base.threadId
  let callId: string | null = null
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${THREAD_MARK}=`)) threadId = entry.slice(THREAD_MARK.length + 1) || threadId
    else if (entry.startsWith(`${CALL_MARK}=`)) callId = entry.slice(CALL_MARK.length + 1) || null
  }
  return { threadId, callId, claudePid: base.claudePid }
}

/** The environment keys the guard reads; on macOS `ps -E` prints them after the command line. */
const MARK_KEYS = [THREAD_MARK, CALL_MARK, 'CLAUDE_PID', 'ANTHROPIC_BASE_URL'] as const

/**
 * `ps -ww -E -o command= -p <pid>` (macOS: the command line, then the
 * `KEY=value` pairs of the environment the process started with) → a
 * NUL-separated environ of the keys the guard reads. The command line is
 * what the scan saw for the pid (`args`): it comes off the front, so a mark
 * written in a command's text (wrapBashCommand's export) is never taken
 * for the process's own; without it, the last pair wins, since the
 * environment follows the command.
 */
export function environFromPsE(text: string, args?: string): string | null {
  const line = text.trimEnd()
  if (!line.trim()) return null
  const prefix = args?.trim()
  const env = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : null
  const out: string[] = []
  for (const key of MARK_KEYS) {
    const matches = [...(env ?? line).matchAll(new RegExp(`(?:^|\\s)${key}=(\\S+)`, 'g'))]
    const m = env ? matches[0] : matches.at(-1)
    if (m) out.push(`${key}=${m[1]}`)
  }
  return out.length ? `${out.join('\0')}\0` : ''
}

/** `ps -u <uid> -o pid=,ppid=,pgid=,rss=,args=` → rows. */
export function parseGuardPs(text: string): GuardProc[] {
  const out: GuardProc[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), rssKb: Number(m[4]), args: m[5].trim() })
  }
  return out
}

const fmtGiB = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
const fmtMB = (bytes: number): string => `${Math.round(bytes / 1048576)}MB`
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

interface OpenCall {
  threadId: string
  startedAt: number
  /** The thread asked for it in the background: its processes are its own until the task ends. */
  background: boolean
}

export class ProcessGuard {
  /** Open calls by id. */
  private readonly calls = new Map<string, OpenCall>()
  /** When a pid was first seen orphaned. */
  private readonly orphanSeen = new Map<number, number>()
  /** Pids and groups (negative) that got SIGTERM, and when: SIGKILL follows after KILL_GRACE_MS when they are still there. */
  private readonly terminated = new Map<number, number>()
  /** Calls the memory cap killed: the tool result's line (tail) comes from here, once. */
  private readonly capped = new Map<string, { rssBytes: number; capBytes: number }>()
  /** Markers by pid and command (a pid is recycled; its command tells). */
  private readonly markers = new Map<string, GuardMarkers>()
  private scanned: { at: number; rows: Promise<GuardProc[]> } | null = null
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: ProcessGuardDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(line))
  }

  start(everyMs = GUARD_TICK_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The calls open right now, for a test. */
  openCalls(): string[] {
    return [...this.calls.keys()]
  }

  /** A shell call started (its tool-call row), or a turn ended (every call of the thread is over). */
  observeEvent(row: EventRow): void {
    const ev = row.event
    if (ev.type === 'tool-call') {
      if (ev.partial || ev.parentCallId) return
      if (!/^(?:Bash|bash|shell|Shell|exec_command|run_terminal_cmd)$/.test(ev.name)) return
      const input = ev.input && typeof ev.input === 'object' ? (ev.input as Record<string, unknown>) : {}
      this.calls.set(ev.callId, { threadId: row.sessionId, startedAt: this.now(), background: input.run_in_background === true })
      return
    }
    if (ev.type === 'status' && SETTLE_STATUSES.has(ev.status)) void this.turnEnded(row.sessionId)
  }

  /** The call ended, however: its processes go, unless the thread backgrounded it on purpose. */
  async callEnded(threadId: string, callId: string): Promise<void> {
    const call = this.calls.get(callId)
    this.calls.delete(callId)
    if (call?.background || this.deps.backgroundCalls(threadId).has(callId)) return
    await this.killCall(callId, 'call ended')
  }

  /** Stop, an error, the harness gone: every open call of the thread is over. */
  async turnEnded(threadId: string): Promise<void> {
    const open = [...this.calls].filter(([, c]) => c.threadId === threadId).map(([id]) => id)
    for (const callId of open) await this.callEnded(threadId, callId)
  }

  /** The line a killed call's tool result carries, once. */
  tail(callId: string): string | null {
    const hit = this.capped.get(callId)
    if (!hit) return null
    this.capped.delete(callId)
    return `${CAP_LINE_PREFIX}: ${fmtGiB(hit.rssBytes)} in use, over the ${fmtGiB(hit.capBytes)} cap per call (setting ${MEMORY_CAP_SETTING}).`
  }

  /** One sweep: the SIGKILLs due, the orphans past their grace, the calls past the cap. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.sweep()
      .catch((err) => this.log(`[guard] sweep failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => (this.ticking = null))
    return this.ticking
  }

  private scan(): Promise<GuardProc[]> {
    const now = this.now()
    if (!this.scanned || now - this.scanned.at >= SCAN_SHARE_MS) this.scanned = { at: now, rows: this.deps.scan() }
    return this.scanned.rows
  }

  private async sweep(): Promise<void> {
    const rows = await this.scan()
    const now = this.now()
    const present = new Set(rows.map((r) => r.pid))
    const ledger = this.deps.ledgerPids()
    const harness = this.deps.harnessPids()
    const own = this.deps.ownPid ?? process.pid
    // SIGKILL what SIGTERM did not end.
    for (const [pid, at] of [...this.terminated]) {
      const alive = pid < 0 ? rows.some((r) => r.pgid === -pid) : present.has(pid)
      if (!alive) this.terminated.delete(pid)
      else if (now - at >= KILL_GRACE_MS) {
        this.deps.kill(pid, 'SIGKILL')
        this.terminated.delete(pid)
        // An orphan that survives even SIGKILL (uninterruptible) is tried again after another grace, not every sweep.
        if (this.orphanSeen.has(pid)) this.orphanSeen.set(pid, now)
      }
    }
    // Orphans: a thread's process with no parent left, past the grace.
    for (const r of rows) {
      if (r.ppid !== 1 || r.pid === own || harness.has(r.pid) || ledger.has(r.pid)) continue
      const m = await this.markersFor(r)
      if (!m.threadId) continue
      if (m.callId && (this.calls.get(m.callId)?.background || this.deps.backgroundCalls(m.threadId).has(m.callId))) continue
      const since = this.orphanSeen.get(r.pid)
      if (since === undefined) {
        this.orphanSeen.set(r.pid, now)
        continue
      }
      if (now - since < ORPHAN_GRACE_MS || this.terminated.has(r.pid)) continue
      this.log(`[guard] orphan thread=${m.threadId} pid=${r.pid} rss=${fmtMB(r.rssKb * 1024)} ${r.args}`)
      if (this.deps.kill(r.pid, 'SIGTERM')) this.terminated.set(r.pid, now)
    }
    for (const pid of [...this.orphanSeen.keys()]) if (!present.has(pid)) this.orphanSeen.delete(pid)
    // The cap: a call's processes over it are killed, and its result will say so.
    if (this.calls.size === 0) return
    const cap = this.deps.capBytes()
    const byCall = new Map<string, { tree: GuardProc[]; bytes: number }>()
    for (const r of rows) {
      if (r.pid === own || harness.has(r.pid)) continue
      const m = await this.markersFor(r)
      if (!m.callId || !this.calls.has(m.callId)) continue
      const entry = byCall.get(m.callId) ?? { tree: [], bytes: 0 }
      entry.tree.push(r)
      entry.bytes += r.rssKb * 1024
      byCall.set(m.callId, entry)
    }
    for (const [callId, { tree, bytes }] of byCall) {
      if (bytes <= cap) continue
      const call = this.calls.get(callId)!
      this.capped.set(callId, { rssBytes: bytes, capBytes: cap })
      this.log(`[guard] cap thread=${call.threadId} call=${callId} rss=${fmtMB(bytes)} over ${fmtMB(cap)}: ${plural(tree.length, 'process', 'processes')} killed`)
      this.killRows(tree, rows, ledger, harness, now)
      this.calls.delete(callId)
    }
  }

  /** Every process carrying the call's mark. */
  private async killCall(callId: string, why: string): Promise<void> {
    const rows = await this.scan()
    const tree: GuardProc[] = []
    for (const r of rows) {
      const m = await this.markersFor(r)
      if (m.callId === callId) tree.push(r)
    }
    if (tree.length === 0) return
    this.log(`[guard] ${why}: call=${callId} ${plural(tree.length, 'process', 'processes')} killed`)
    this.killRows(tree, rows, this.deps.ledgerPids(), this.deps.harnessPids(), this.now())
  }

  /**
   * SIGTERM a tree: a whole process group when it is the call's own (its
   * leader is in the tree, or every member is) and holds no harness, ledger
   * pid or this process; single pids otherwise. SIGKILL follows on the sweep
   * after KILL_GRACE_MS.
   */
  private killRows(tree: GuardProc[], all: GuardProc[], ledger: Set<number>, harness: Set<number>, now: number): void {
    const own = this.deps.ownPid ?? process.pid
    const inTree = new Set(tree.map((r) => r.pid))
    const guarded = (pid: number): boolean => pid === own || ledger.has(pid) || harness.has(pid)
    const left = new Set(inTree)
    for (const pgid of new Set(tree.map((r) => r.pgid))) {
      const members = all.filter((r) => r.pgid === pgid)
      const ours = inTree.has(pgid) || members.every((r) => inTree.has(r.pid))
      if (!ours || members.some((r) => guarded(r.pid))) continue
      if (this.deps.kill(-pgid, 'SIGTERM')) this.terminated.set(-pgid, now)
      for (const r of members) left.delete(r.pid)
    }
    for (const pid of left) {
      if (guarded(pid)) continue
      if (this.deps.kill(pid, 'SIGTERM')) this.terminated.set(pid, now)
    }
  }

  private async markersFor(r: GuardProc): Promise<GuardMarkers> {
    const key = `${r.pid}:${r.args}`
    let m = this.markers.get(key)
    if (!m) {
      const read = markersOf(await this.deps.environ(r.pid, r.args))
      const threadId = read.threadId ?? (read.claudePid ? (this.deps.threadOfHarness?.(read.claudePid) ?? `claude:${read.claudePid}`) : null)
      m = { threadId, callId: read.callId }
      this.markers.set(key, m)
      if (this.markers.size > 5_000) this.markers.delete(this.markers.keys().next().value as string)
    }
    return m
  }
}

// ── the host's deps ──────────────────────────────────────────────────

const psRows = (): Promise<string> =>
  new Promise((resolve) => {
    const uid = process.getuid?.()
    const args = uid === undefined ? ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,rss=,args='] : ['-ww', '-u', String(uid), '-o', 'pid=,ppid=,pgid=,rss=,args=']
    execFile('ps', args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })

/** macOS has no /proc: `ps -E` shows a process's environment after its command line (one child per process the guard has to decide about; the markers cache keeps it to once per process). */
const darwinEnviron = (pid: number, args?: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile('ps', ['-ww', '-E', '-o', 'command=', '-p', String(pid)], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : environFromPsE(String(stdout ?? ''), args)))
  })

export function hostGuardDeps(): Pick<ProcessGuardDeps, 'scan' | 'environ' | 'kill'> {
  return {
    scan: async () => parseGuardPs(await psRows()),
    environ: (pid, args) =>
      process.platform === 'linux'
        ? readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null)
        : process.platform === 'darwin'
          ? darwinEnviron(pid, args)
          : Promise.resolve(null),
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    }
  }
}
