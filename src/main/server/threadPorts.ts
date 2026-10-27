import { execFileBudgeted } from './spawnBudget'
import type { ThreadResource } from '@shared/contract-resources'
import { notDevServer, underRunner } from '@shared/devServerRules'
import type { EventRow } from '@shared/events'
import type { ThreadResources } from './threadResources'
import { shellOf } from './threadResourcesParse'
import { announcedPorts, byPort, descendants, parseArgs, parseLsof, parsePs, parseSs, parseStarts, portLabel, validPort, type Listener } from './threadPortsParse'

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
 * While the host has live port rows (from boot: index.ts arms the poll) a
 * slower sweep (LIVE_MS) ends a row the moment nothing listens on its port
 * ("stopped listening") or its process is gone ("its process is gone"),
 * except that a listener under the thread's own harness that took the port
 * is followed (a watcher restarted the server). One live row per port on a
 * host: the ledger's unique index (db.ts thread_resources_live) collapses a
 * second detection, and a cluster listening on one port is one row.
 */

export interface Scan {
  listeners: Listener[]
  /** pid → parent pid. */
  parents: Map<number, number>
  /** pid → when it started (epoch ms); absent from a scan that did not read it. */
  started?: Map<number, number>
  /** pid → its command line; absent from a scan that did not read it. The
   *  ancestry rule reads it: a listener under the gate, a typecheck or a
   *  test run, however deep, is never a dev server. */
  args?: Map<number, string>
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
    run('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='])
  ])
  return { listeners: listen, parents: parsePs(ps), started: parseStarts(ps, Date.now()), args: parseArgs(ps) }
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
      // The listener's own command line and every process between it and
      // the harness: a worker of the gate, a typecheck or a test run the
      // call ran (by a script, say) is the runner's, whatever the call said.
      if (underRunner(this.ancestry(scan, l.pid, pid))) continue
      const running = [...a.calls.entries()].at(-1)
      const by = callId ? { callId, command: command ?? '' } : running ? { callId: running[0], command: running[1] } : a.last
      if (!by) continue
      this.record(sessionId, l.port, l.pid, by.callId, portLabel(l.port, { command: by.command, process: l.command }), l.command)
    }
  }

  /** The command lines from `pid` up to (not including) `root`, nearest first. */
  private ancestry(scan: Scan, pid: number, root: number): (string | undefined)[] {
    const out: (string | undefined)[] = []
    for (let p: number | undefined = pid, hops = 0; p !== undefined && p !== root && hops < 32; p = scan.parents.get(p), hops++) {
      out.push(scan.args?.get(p))
    }
    return out
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
      const port = Number(r.identifier)
      const on = ports.get(port)
      if (!on?.length) {
        this.deps.resources.ended(this.deps.environmentId, 'port', r.identifier, 'stopped listening')
        this.log(`port ${r.identifier} stopped listening`)
        continue
      }
      if (!r.pid || on.some((l) => l.pid === r.pid) || scan.parents.has(r.pid)) continue
      // The row's process is gone. A listener under the thread's own harness took the port (a watcher's restart): the row follows it; anyone else's is not this server.
      const harness = this.deps.harnessPid(r.sessionId)
      const own = harness ? this.under(scan, harness).find((l) => l.port === port) : undefined
      if (own) {
        this.deps.resources.setPid(r.id, own.pid)
        this.log(`port ${r.identifier}: pid ${r.pid} is gone, following ${own.pid}`)
      } else {
        this.deps.resources.ended(this.deps.environmentId, 'port', r.identifier, 'its process is gone')
        this.log(`port ${r.identifier}: pid ${r.pid} is gone`)
      }
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.active.clear()
  }
}
