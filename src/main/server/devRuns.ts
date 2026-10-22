import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { DevRun, DevRunPush, DevTarget } from '@shared/contract-devservers'
import type { ForwardedPort, PortForwardInfo } from '@shared/contract-ports'
import { detectDevTargets } from './devTargets'
import { loginShell } from './loginShell'
import { trackChild } from './spawnBudget'
import type { SharedScanner } from './threadPorts'
import { announcedPorts, byPort, descendants, validPort } from './threadPortsParse'

/**
 * The Dev Server button's engine (docs/box.md "Dev servers on the box"): one
 * run per target, in the project checkout through the login shell, in its own
 * process group so Stop takes the whole tree (SIGTERM, SIGKILL after 5 s). The
 * log streams to every client in ~100 ms batches with a ring buffer for the
 * console's replay, like the Build rail. A run's ports are the listeners under
 * its process tree (scanned at 1 s and every 3 s while it runs), labelled with
 * the URL the server announced; they go to the Macs like a thread's ports, as
 * `dev:<runId>:<port>`.
 */

const LOG_CAP = 3_000
const BATCH_MS = 100
const KILL_GRACE_MS = 5_000
const FIRST_SCAN_MS = 1_000
const SCAN_MS = 3_000
/** Finished runs kept per project for the menu. */
const KEEP_FINISHED = 8

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export interface DevRunsDeps {
  project: (projectId: string) => { id: string; name: string; cwd: string } | null
  scanner: SharedScanner
  forwardsOf: (forwardId: string) => PortForwardInfo[]
  /** The offered ports changed (the forward sends the Macs the list again). */
  offersChanged: () => void
  env?: () => Promise<NodeJS.ProcessEnv>
  platform?: NodeJS.Platform
  /** Detection, for tests. */
  detect?: (cwd: string, name: string) => Promise<DevTarget[]>
  log?: (line: string) => void
}

interface Slot {
  run: DevRun
  lines: string[]
  pending: string[]
  timer: NodeJS.Timeout | null
  child: ChildProcess | null
  killTimer: NodeJS.Timeout | null
  scanTimer: NodeJS.Timeout | null
  stopping: boolean
  /** Ports the log announced, with their URL. */
  announced: Map<number, string>
  done: Promise<void>
  resolveDone: () => void
}

export const forwardIdOf = (runId: string, port: number): string => `dev:${runId}:${port}`

export class DevRuns {
  private readonly slots = new Map<string, Slot>()
  private readonly listeners = new Set<(push: DevRunPush) => void>()
  private readonly log: (line: string) => void

  constructor(private readonly deps: DevRunsDeps) {
    this.log = deps.log ?? ((line) => console.log(`[dev-server] ${line}`))
  }

  onPush(listener: (push: DevRunPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private must(projectId: string): { id: string; name: string; cwd: string } {
    const p = this.deps.project(projectId)
    if (!p) throw new Error(`unknown project: ${projectId}`)
    return p
  }

  private runs(projectId: string): DevRun[] {
    return [...this.slots.values()]
      .filter((s) => s.run.projectId === projectId)
      .map((s) => this.view(s))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  async targets(projectId: string): Promise<{ targets: DevTarget[]; runs: DevRun[] }> {
    const p = this.must(projectId)
    return { targets: await (this.deps.detect ?? detectDevTargets)(p.cwd, p.name), runs: this.runs(projectId) }
  }

  private slot(runId: string): Slot {
    const s = this.slots.get(runId)
    if (!s) throw new Error(`unknown dev run: ${runId}`)
    return s
  }

  /** The run with its ports' forwards filled in. */
  private view(s: Slot): DevRun {
    return { ...s.run, ports: s.run.ports.map((p) => ({ ...p, forwards: this.deps.forwardsOf(forwardIdOf(s.run.id, p.port)) })) }
  }

  history(runId: string): { run: DevRun; lines: string[] } {
    const s = this.slot(runId)
    return { run: this.view(s), lines: s.lines.slice() }
  }

  async start(projectId: string, targetId: string): Promise<DevRun> {
    const p = this.must(projectId)
    const live = [...this.slots.values()].find((s) => s.run.projectId === projectId && s.run.targetId === targetId && s.run.status === 'running')
    if (live) return this.view(live)
    const target = (await (this.deps.detect ?? detectDevTargets)(p.cwd, p.name)).find((t) => t.id === targetId)
    if (!target) throw new Error(`no such dev target in ${p.name}: ${targetId}`)
    if (target.macOnly && (this.deps.platform ?? process.platform) !== 'darwin') throw new Error(`${target.name} runs on a Mac: an iOS app needs Xcode and a simulator`)
    const cwd = target.dir ? join(p.cwd, target.dir) : p.cwd
    let resolveDone = () => {}
    const done = new Promise<void>((r) => (resolveDone = r))
    const s: Slot = {
      run: {
        id: nanoid(10),
        projectId,
        targetId,
        name: target.name,
        script: target.script,
        kind: target.kind,
        command: target.command,
        cwd,
        status: 'running',
        pid: null,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        ports: []
      },
      lines: [],
      pending: [],
      timer: null,
      child: null,
      killTimer: null,
      scanTimer: null,
      stopping: false,
      announced: new Map(),
      done,
      resolveDone
    }
    this.prune(projectId, targetId)
    this.slots.set(s.run.id, s)
    const env = { ...(this.deps.env ? await this.deps.env() : process.env), BROWSER: 'none', FORCE_COLOR: '0' }
    const child = trackChild(spawn(loginShell(), ['-lc', target.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
    s.child = child
    s.run.pid = child.pid ?? null
    this.log(`${p.name}: ${target.name} ${target.script} started (pid ${s.run.pid ?? '?'})`)
    const feed = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop() ?? ''
        this.lines(s, parts)
      })
      stream.on('end', () => {
        if (rest) this.lines(s, [rest])
      })
    }
    feed(child.stdout)
    feed(child.stderr)
    child.on('error', (err) => {
      this.lines(s, [err.message])
      this.finish(s, null)
    })
    child.on('close', (code) => this.finish(s, code))
    this.scheduleScan(s, FIRST_SCAN_MS)
    this.emit(s, [])
    return this.view(s)
  }

  /** Older finished runs of a project beyond the cap leave; a target's finished runs give way to its new one. */
  private prune(projectId: string, targetId: string): void {
    const finished = [...this.slots.values()].filter((s) => s.run.projectId === projectId && s.run.status !== 'running')
    for (const s of finished) if (s.run.targetId === targetId) this.slots.delete(s.run.id)
    const rest = finished.filter((s) => s.run.targetId !== targetId).sort((a, b) => b.run.startedAt - a.run.startedAt)
    for (const s of rest.slice(KEEP_FINISHED)) this.slots.delete(s.run.id)
  }

  async stop(runId: string): Promise<DevRun> {
    const s = this.slot(runId)
    const pid = s.child?.pid
    if (s.run.status !== 'running' || !pid) return this.view(s)
    s.stopping = true
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        s.child?.kill(sig)
      }
    }
    signal('SIGTERM')
    s.killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
    await s.done
    return this.view(s)
  }

  async restart(runId: string): Promise<DevRun> {
    const s = this.slot(runId)
    await this.stop(runId)
    return this.start(s.run.projectId, s.run.targetId)
  }

  private lines(s: Slot, raw: string[]): void {
    const lines = raw.map((l) => l.replace(ANSI, '').replace(/\r$/, ''))
    for (const a of announcedPorts(lines.join('\n'))) if (!s.announced.has(a.port)) s.announced.set(a.port, a.url)
    s.lines.push(...lines)
    if (s.lines.length > LOG_CAP) s.lines.splice(0, s.lines.length - LOG_CAP)
    s.pending.push(...lines)
    s.timer ??= setTimeout(() => this.flush(s), BATCH_MS)
    // A port announced: look for its listener now rather than at the next scan.
    if (s.announced.size > s.run.ports.length) this.scheduleScan(s, 200)
  }

  private flush(s: Slot): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (!s.pending.length) return
    const lines = s.pending
    s.pending = []
    this.emit(s, lines)
  }

  private scheduleScan(s: Slot, ms: number): void {
    if (s.run.status !== 'running') return
    if (s.scanTimer) clearTimeout(s.scanTimer)
    s.scanTimer = setTimeout(() => {
      s.scanTimer = null
      void this.scan(s).finally(() => this.scheduleScan(s, SCAN_MS))
    }, ms)
    s.scanTimer.unref?.()
  }

  /** The listeners under the run's tree are its ports. */
  private async scan(s: Slot): Promise<void> {
    const pid = s.run.pid
    if (!pid || s.run.status !== 'running') return
    const scan = await this.deps.scanner.get()
    if (s.run.status !== 'running') return
    const tree = descendants(scan.parents, [pid])
    const ports = [...byPort(scan.listeners.filter((l) => tree.has(l.pid))).keys()].filter(validPort).sort((a, b) => a - b)
    const next = ports.map((port) => ({ port, url: s.announced.get(port) ?? `http://localhost:${port}`, forwards: [] }))
    if (JSON.stringify(next.map((p) => [p.port, p.url])) === JSON.stringify(s.run.ports.map((p) => [p.port, p.url]))) return
    s.run.ports = next
    this.emit(s, [])
    this.deps.offersChanged()
  }

  private finish(s: Slot, code: number | null): void {
    if (s.run.status !== 'running') return
    if (s.killTimer) clearTimeout(s.killTimer)
    if (s.scanTimer) clearTimeout(s.scanTimer)
    s.killTimer = s.scanTimer = null
    s.child = null
    this.flush(s)
    const status = s.stopping ? 'stopped' : code === 0 ? 'exited' : 'failed'
    const hadPorts = s.run.ports.length > 0
    s.run = { ...s.run, status, endedAt: Date.now(), exitCode: code, ports: [] }
    this.log(`${s.run.name} ${s.run.script}: ${status}${code !== null ? ` (${code})` : ''}`)
    this.emit(s, [])
    if (hadPorts) this.deps.offersChanged()
    s.resolveDone()
  }

  private emit(s: Slot, lines: string[]): void {
    const push: DevRunPush = { push: 'dev-run', projectId: s.run.projectId, run: this.view(s), lines }
    for (const l of this.listeners) l(push)
  }

  /** Every running run's ports, for the Macs. */
  offers(): ForwardedPort[] {
    const out: ForwardedPort[] = []
    for (const s of this.slots.values()) {
      if (s.run.status !== 'running') continue
      const title = `${s.run.name} · ${s.run.script}`
      for (const p of s.run.ports) out.push({ id: forwardIdOf(s.run.id, p.port), port: p.port, label: p.url, title, sessionId: null, runId: s.run.id })
    }
    return out
  }

  /** The Macs bound some forwards: the runs behind them push their new state. */
  bound(ids: readonly string[]): void {
    const runIds = new Set(ids.filter((id) => id.startsWith('dev:')).map((id) => id.split(':')[1]))
    for (const id of runIds) {
      const s = this.slots.get(id)
      if (s) this.emit(s, [])
    }
  }

  disposeAll(): void {
    for (const s of this.slots.values()) if (s.run.status === 'running') void this.stop(s.run.id)
  }
}
