import { execFileBudgeted } from './spawnBudget'
import type { ThreadResource } from '@shared/contract-resources'
import { notDevServer } from '@shared/devServerRules'
import type { EventRow } from '@shared/events'
import type { ThreadResources } from './threadResources'
import { shellOf } from './threadResourcesParse'
import { announcedPorts, byPort, descendants, parseLsof, parsePs, parseSs, parseStarts, portLabel, validPort, type Listener } from './threadPortsParse'

/**
 * Dev servers a thread starts, filed in the ledger as `port` rows (docs/box.md
 * "Dev servers on the box"). Two per-call detectors, both conservative (a
 * background shell's server, reparented to init, is portSweep.ts's):
 *
 *  - the server's own announcement in a shell call's output ("Local:
 *    http://localhost:5173"), recorded only when something listens on that
 *    port at the call's end (which gives the pid);
 *  - a listener that appears under the thread's harness process while a
 *    shell call runs (and for GRACE_MS after the last one ends), polled every
 *    POLL_MS. Listeners already under the harness when the thread's first
 *    call starts (an MCP server) are the baseline and never recorded.
 *
 * While the host has live port rows a slower sweep (LIVE_MS) stamps the ones
 * nothing listened on in two sweeps running ("stopped listening") and follows a listener
 * that changed pid (a watcher restarted the server).
 */

export interface Scan {
  listeners: Listener[]
  /** pid → parent pid. */
  parents: Map<number, number>
  /** pid → when it started (epoch ms); absent from a scan that did not read it. */
  started?: Map<number, number>
}

const run = async (cmd: string, args: string[]): Promise<string> => {
  try {
    return (await execFileBudgeted(cmd, args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? '')
  }
}

/** The host's TCP listeners and process tree: ss on Linux, lsof on macOS, ps on both. */
export async function scanHost(platform: NodeJS.Platform = process.platform): Promise<Scan> {
  const [listen, ps] = await Promise.all([
    platform === 'linux' ? run('ss', ['-ltnpH']).then(parseSs) : run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']).then(parseLsof),
    run('ps', ['-A', '-o', 'pid=,ppid=,etime='])
  ])
  return { listeners: listen, parents: parsePs(ps), started: parseStarts(ps, Date.now()) }
}

/** One scan shared by everyone who asks within `maxAgeMs` (the watcher and the dev runs). */
export class SharedScanner {
  private last: { at: number; scan: Promise<Scan> } | null = null
  private pending: Promise<Scan> | null = null
  constructor(
    private readonly scan: () => Promise<Scan> = () => scanHost(),
    private readonly now: () => number = Date.now
  ) {}
  get(maxAgeMs = 500): Promise<Scan> {
    if (this.pending) return this.pending
    if (this.last && this.now() - this.last.at < maxAgeMs) return this.last.scan
    const scan = this.scan().catch(() => ({ listeners: [], parents: new Map() }))
    this.pending = scan
    void scan.then(() => { if (this.pending === scan) this.pending = null })
    this.last = { at: this.now(), scan }
    return scan
  }
}

export const POLL_MS = 2_000
export const GRACE_MS = 10_000
export const LIVE_MS = 10_000
export const STALE_CALL_MS = 30 * 60_000

interface Active {
  /** Shell calls running now, oldest first: callId → command text. */
  calls: Map<string, string>
  /** When each call started: one whose result never came (an interrupted turn) stops counting after STALE_CALL_MS. */
  startedAt: Map<string, number>
  last: { callId: string; command: string } | null
  until: number
  /** Ports under the harness when the thread was first seen; null until the first scan lands. */
  baseline: Set<number> | null
}

export interface ThreadPortsDeps {
  resources: Pick<ThreadResources, 'record' | 'listAll' | 'live' | 'ended' | 'setPid'>
  environmentId: string
  harnessPid: (sessionId: string) => number | null
  scanner: SharedScanner
  now?: () => number
  log?: (line: string) => void
}

export class ThreadPorts {
  private readonly active = new Map<string, Active>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private timer: NodeJS.Timeout | null = null
  private lastLive = 0
  /** Live sweeps in a row that found nothing on a row's port: two stamp it (a watcher's restart is one). */
  private readonly missed = new Map<string, number>()
  private ticking: Promise<void> | null = null
  private readonly endListeners = new Set<(sessionId: string, callId: string) => void>()

  constructor(private readonly deps: ThreadPortsDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[ports] ${line}`))
  }

  /** A shell call ended (after its ports were settled). */
  onCallEnd(listener: (sessionId: string, callId: string) => void): () => void {
    this.endListeners.add(listener)
    return () => this.endListeners.delete(listener)
  }

  /** The session a shell call ran in (a subagent's call files its port under the root, but the subagent is the one to tell). */
  private readonly callOwners = new Map<string, string>()

  sessionOfCall(callId: string): string | null {
    return this.callOwners.get(callId) ?? null
  }

  /** Whether a shell call is still running. */
  running(callId: string): boolean {
    const owner = this.callOwners.get(callId)
    return owner ? (this.active.get(owner)?.calls.has(callId) ?? false) : false
  }

  observeEvent(row: EventRow): void {
    const ev = row.event
    if (ev.type === 'tool-call') {
      if (ev.partial) return
      const shell = shellOf(ev.input)
      if (!shell) return
      this.callStarted(row.sessionId, ev.callId, shell.command ?? shell.argv?.join(' ') ?? '')
      return
    }
    if (ev.type === 'tool-result' && this.active.get(row.sessionId)?.calls.has(ev.callId)) void this.settle(row.sessionId, ev.callId, ev.output)
  }

  callStarted(sessionId: string, callId: string, command: string): void {
    let a = this.active.get(sessionId)
    if (!a) {
      a = { calls: new Map(), startedAt: new Map(), last: null, until: 0, baseline: null }
      this.active.set(sessionId, a)
      void this.takeBaseline(sessionId, a)
    }
    a.calls.set(callId, command)
    a.startedAt.set(callId, this.now())
    this.callOwners.set(callId, sessionId)
    if (this.callOwners.size > 512) this.callOwners.delete(this.callOwners.keys().next().value as string)
    this.arm()
  }

  private async takeBaseline(sessionId: string, a: Active): Promise<void> {
    const pid = this.deps.harnessPid(sessionId)
    const scan = await this.deps.scanner.get()
    if (a.baseline) return
    a.baseline = new Set(pid ? this.under(scan, pid).map((l) => l.port) : [])
  }

  /**
   * A shell call ended: its announced ports with a listener are recorded, the
   * tree is scanned once more, and the call's port rows come back (the tool
   * result's tail names their forwards). Idempotent per call.
   */
  async settle(sessionId: string, callId: string, output: string): Promise<ThreadResource[]> {
    const a = this.active.get(sessionId)
    const command = a?.calls.get(callId) ?? (a?.last?.callId === callId ? a.last.command : '')
    if (a?.calls.has(callId)) {
      a.calls.delete(callId)
      a.startedAt.delete(callId)
      a.last = { callId, command }
      a.until = this.now() + GRACE_MS
    }
    const announced = announcedPorts(output)
    // Most calls announce nothing: the poll (every POLL_MS, through the grace) finds what they left listening.
    if (!announced.length) {
      for (const l of this.endListeners) l(sessionId, callId)
      this.arm()
      return this.callPorts(callId)
    }
    const scan = await this.deps.scanner.get(0)
    const ports = byPort(scan.listeners)
    for (const ann of announced) {
      const l = ports.get(ann.port)
      if (!l) continue
      this.record(sessionId, ann.port, l.pid, callId, portLabel(ann.port, { url: ann.url }))
    }
    if (a) this.fromTree(sessionId, a, scan, callId, command)
    for (const l of this.endListeners) l(sessionId, callId)
    this.arm()
    return this.callPorts(callId)
  }

  private callPorts(callId: string): ThreadResource[] {
    return this.deps.resources.listAll({ kind: 'port', environmentId: this.deps.environmentId }).filter((r) => r.callId === callId)
  }

  private under(scan: Scan, root: number): Listener[] {
    const tree = descendants(scan.parents, [root])
    return scan.listeners.filter((l) => tree.has(l.pid))
  }

  /** New listeners under the harness, outside the baseline: the running call's (else the last one's). */
  private fromTree(sessionId: string, a: Active, scan: Scan, callId?: string, command?: string): void {
    if (!a.baseline) return
    const pid = this.deps.harnessPid(sessionId)
    if (!pid) return
    for (const l of byPort(this.under(scan, pid)).values()) {
      if (a.baseline.has(l.port) || !validPort(l.port)) continue
      if (this.deps.resources.live(this.deps.environmentId, 'port', String(l.port))) continue
      const running = [...a.calls.entries()].at(-1)
      const by = callId ? { callId, command: command ?? '' } : running ? { callId: running[0], command: running[1] } : a.last
      if (!by) continue
      this.record(sessionId, l.port, l.pid, by.callId, portLabel(l.port, { command: by.command, process: l.command }), l.command)
    }
  }

  /** A database, an MCP server or a test run's worker is never filed (src/shared/devServerRules.ts). */
  private record(sessionId: string, port: number, pid: number, callId: string, label: string, name: string | null = null): void {
    if (notDevServer(port, name, label)) return
    const made = this.deps.resources.record(sessionId, this.deps.environmentId, {
      created: [{ kind: 'port', identifier: String(port), label, branch: null, pid, callId }],
      removed: []
    })
    if (made.length) this.log(`thread=${sessionId} port ${port} pid ${pid}`)
  }

  /** Follow the live rows (a row the host-wide sweep recorded, portSweep.ts). */
  arm(): void {
    if (this.timer) return
    if (!this.active.size && !this.deps.resources.listAll({ kind: 'port', environmentId: this.deps.environmentId }).length) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.ticking ??= this.tick().finally(() => (this.ticking = null))
      void this.ticking.then(() => this.arm())
    }, this.active.size ? POLL_MS : LIVE_MS)
    this.timer.unref?.()
  }

  /** One poll: the active threads' trees, then (every LIVE_MS) the live rows. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const [id, a] of this.active) {
      for (const [callId, at] of a.startedAt)
        if (now - at > STALE_CALL_MS) {
          a.calls.delete(callId)
          a.startedAt.delete(callId)
        }
      if (!a.calls.size && a.until <= now) this.active.delete(id)
    }
    const rows = this.deps.resources.listAll({ kind: 'port', environmentId: this.deps.environmentId })
    const live = rows.length > 0 && now - this.lastLive >= LIVE_MS
    if (!this.active.size && !live) return
    const scan = await this.deps.scanner.get()
    for (const [id, a] of this.active) this.fromTree(id, a, scan)
    // A failed scan reads as no listeners at all; never stamp a row from that.
    if (!live || !scan.listeners.length) return
    this.lastLive = now
    const ports = new Map<number, Listener[]>()
    for (const l of scan.listeners) ports.set(l.port, [...(ports.get(l.port) ?? []), l])
    for (const r of rows) {
      const on = ports.get(Number(r.identifier))
      if (!on?.length) {
        const n = (this.missed.get(r.id) ?? 0) + 1
        this.missed.set(r.id, n)
        if (n < 2) continue
        this.missed.delete(r.id)
        this.deps.resources.ended(this.deps.environmentId, 'port', r.identifier, 'stopped listening')
        this.log(`port ${r.identifier} stopped listening`)
        continue
      }
      this.missed.delete(r.id)
      if (r.pid && !on.some((l) => l.pid === r.pid) && !scan.parents.has(r.pid)) this.deps.resources.setPid(r.id, on[0].pid)
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.active.clear()
  }
}
