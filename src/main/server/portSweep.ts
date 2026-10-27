import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { notDevServer, underRunner } from '@shared/devServerRules'
import { listenerWords } from '@shared/devServerWords'
import type { EventRow } from '@shared/events'
import type { ThreadResources } from './threadResources'
import { shellOf } from './threadResourcesParse'
import type { SharedScanner } from './threadPorts'
import { byPort, portLabel, validPort, type Listener } from './threadPortsParse'

/**
 * The host-wide dev server sweep (docs/box.md "Dev servers on the box"). An
 * agent starts its dev server with a background shell (Claude's
 * `run_in_background`, `&`, nohup): the call returns at once, the output goes
 * to a file and the server is reparented to init, so the per-call detectors in
 * threadPorts.ts never see it. This one reads every TCP listener on the host
 * when a shell call settles and every SWEEP_MS while a harness is live, looks
 * only at listeners it has not decided yet (nothing changed: no /proc or lsof
 * read), and credits each to a thread by, in order:
 *
 *  - ancestry: a thread's harness pid above the process;
 *  - environment (Linux): the thread id in the inherited ANTHROPIC_BASE_URL
 *    scope (`~t=<id>`), else the harness pid a Claude tool call inherits
 *    (CLAUDE_PID), both of which survive the reparenting;
 *  - output file: stdout or stderr on a file a shell call named (Claude's
 *    "Output is being written to: …/tasks/<id>.output", or the command's own
 *    `> /tmp/web.log`);
 *  - working directory: the process's (or an ancestor's) cwd inside a
 *    thread's cwd, the deepest folder first, then a live thread, then the most
 *    recently active; only a thread that existed before the process started
 *    and was live or active since.
 *
 * What is clearly not a dev server is skipped: the app's own listeners,
 * databases, proxies, MCP servers and debuggers (src/shared/devServerRules.ts), a process the harness
 * started with itself (an MCP server: within HARNESS_BOOT_MS of the harness
 * and not from a tool call), the Dev Server button's runs, and a port bound
 * before any thread worked in its folder.
 */

export const SWEEP_MS = 15_000
/** After a shell call settles: a server takes a few seconds to bind. */
export const SETTLE_SWEEP_MS = 3_000
/** A process the harness started this soon after itself is the harness's own (an MCP server). */
export const HARNESS_BOOT_MS = 15_000
/** A listener no thread claimed is looked at again after this long (a thread may have started there since). */
export const RETRY_MS = 5 * 60_000
/** How far up from the listener the chain is read. */
const CHAIN_DEPTH = 8

export interface ProcInfo {
  pid: number
  ppid: number | null
  /** Epoch ms, to the second; null when ps did not say. */
  startedAt: number | null
  cwd: string | null
  /** The command line, for the label. */
  args: string | null
  /** The thread its harness was routed for (`~t=` in the inherited ANTHROPIC_BASE_URL), Linux only. */
  threadId: string | null
  /** The harness pid a Claude tool call inherits (CLAUDE_PID), Linux only. */
  claudePid: number | null
  /** What fd 1 and 2 point at, a deleted file's " (deleted)" kept. */
  files: string[]
}

export interface SweepThread {
  id: string
  cwd: string
  harnessPid: number | null
  /** When the harness process started, from the scan. */
  harnessStartedAt: number | null
  /** A harness is up, or its status is live. */
  live: boolean
  createdAt: number
  activeAt: number
}

export interface CallRef {
  sessionId: string
  callId: string
}

export type CreditRule = 'ancestry' | 'environment' | 'output-file' | 'cwd'
export type Verdict = { credit: { sessionId: string; callId: string | null; by: CreditRule } } | { skip: string; final: boolean }

export interface AttributeContext {
  threads: readonly SweepThread[]
  /** The shell call that named a file as its output. */
  fileOwner: (path: string) => CallRef | null
  ownPid: number
  /** The home directory: a thread whose cwd is home (or /) names no folder. */
  home: string
}

const stripDeleted = (p: string): string => p.replace(/ \(deleted\)$/, '')
const baseName = (s: string | null): string => (s ?? '').split(/\s+/)[0].split('/').pop() ?? ''
const SHELL = /^(?:\S*\/)?(?:ba|z|da|fi)?sh$/

/** The command a server reads as: the topmost process of its own (not a shell, not a stop) in the chain, else the listener's. */
export function serverCommand(chain: readonly ProcInfo[], stops: ReadonlySet<number>): string | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i]
    if (stops.has(p.pid) || !p.args || SHELL.test(p.args.split(/\s+/)[0])) continue
    return p.args
  }
  return chain[0]?.args ?? null
}

const inside = (dir: string, folder: string): boolean => dir === folder || dir.startsWith(folder.endsWith('/') ? folder : `${folder}/`)

/** Why a listener is not a dev server, null when it may be one. `chain` starts at the listener's process. */
export function skipReason(l: Listener, chain: readonly ProcInfo[], ownPid: number): string | null {
  if (!validPort(l.port)) return 'a system port'
  if (l.pid === ownPid) return "the app's own"
  const own = notDevServer(l.port, l.command ?? baseName(chain[0]?.args ?? null), chain[0]?.args ?? null)
  if (own) return own
  // A test worker sits under its runner: the gate, vitest, a typecheck.
  return underRunner(chain.map((p) => p.args)) ? 'a test run or the gate' : null
}

/** Which thread a listener is, by the rules above; `chain` starts at the listener's process and goes up. */
export function attribute(l: Listener, chain: readonly ProcInfo[], ctx: AttributeContext): Verdict {
  const skip = skipReason(l, chain, ctx.ownPid)
  if (skip) return { skip, final: true }
  const fromToolCall = chain.some((p) => p.claudePid !== null)

  // Ancestry: still under a harness.
  for (let i = 0; i < chain.length; i++) {
    const t = ctx.threads.find((x) => x.harnessPid === chain[i].pid)
    if (!t) continue
    if (i === 0) return { skip: 'the harness itself', final: true }
    const below = chain[i - 1]
    if (!fromToolCall && below.startedAt !== null && t.harnessStartedAt !== null && below.startedAt - t.harnessStartedAt < HARNESS_BOOT_MS)
      return { skip: 'started with the harness (an MCP server)', final: true }
    return { credit: { sessionId: t.id, callId: null, by: 'ancestry' } }
  }

  // Environment: the scope and the harness pid survive the reparenting.
  for (const p of chain) {
    const byId = p.threadId ? ctx.threads.find((t) => t.id === p.threadId) : undefined
    const byPid = p.claudePid ? ctx.threads.find((t) => t.harnessPid === p.claudePid) : undefined
    const t = byId ?? byPid
    if (t) return { credit: { sessionId: t.id, callId: null, by: 'environment' } }
  }

  // Output file: the shell call that named it.
  for (const p of chain)
    for (const f of p.files) {
      const owner = ctx.fileOwner(stripDeleted(f))
      if (owner) return { credit: { sessionId: owner.sessionId, callId: owner.callId, by: 'output-file' } }
    }

  // Working directory: the deepest thread folder holding it, live first, then the most recently active.
  const start = chain[0]?.startedAt ?? null
  for (const p of chain) {
    if (!p.cwd) continue
    const candidates = ctx.threads.filter((t) => t.cwd.length > 1 && t.cwd !== ctx.home && inside(p.cwd as string, t.cwd))
    if (!candidates.length) continue
    const eligible = candidates.filter((t) => start === null || (t.createdAt <= start && (t.live || t.activeAt >= start)))
    if (!eligible.length) return { skip: `bound before a thread worked in ${p.cwd}`, final: true }
    eligible.sort((a, b) => b.cwd.length - a.cwd.length || Number(b.live) - Number(a.live) || b.activeAt - a.activeAt)
    return { credit: { sessionId: eligible[0].id, callId: null, by: 'cwd' } }
  }
  return { skip: 'no thread', final: false }
}

/** `~t=<id>` in an ANTHROPIC_BASE_URL, and CLAUDE_PID, from a NUL-separated environ. */
export function parseEnviron(text: string): { threadId: string | null; claudePid: number | null } {
  let threadId: string | null = null
  let claudePid: number | null = null
  for (const entry of text.split('\0')) {
    if (entry.startsWith('ANTHROPIC_BASE_URL=')) {
      const m = /~t=([^;/?&]+)/.exec(entry)
      if (m) threadId = decodeURIComponent(m[1])
    } else if (entry.startsWith('CLAUDE_PID=')) {
      const n = Number(entry.slice('CLAUDE_PID='.length))
      if (Number.isInteger(n) && n > 1) claudePid = n
    }
  }
  return { threadId, claudePid }
}

/** Files a shell call names as its output: Claude's background task file, and absolute redirect targets in the command. */
export function outputPaths(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:^|[\s;&|(])(?:\d?>>?|&>>?)\s*(\/[^\s;&|<>()'"`]+)/g)) if (!m[1].startsWith('/dev/')) out.add(m[1])
  for (const m of text.matchAll(/(\/[^\s'"`]+\/tasks\/[^\s'"`/]+\.output)\b/g)) out.add(m[1])
  return [...out]
}

type Probe = (pid: number) => Promise<Pick<ProcInfo, 'cwd' | 'args' | 'threadId' | 'claudePid' | 'files'>>

async function linuxProbe(pid: number): ReturnType<Probe> {
  const [cwd, cmdline, environ, fd1, fd2] = await Promise.all([
    readlink(`/proc/${pid}/cwd`).catch(() => null),
    readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''),
    readlink(`/proc/${pid}/fd/1`).catch(() => null),
    readlink(`/proc/${pid}/fd/2`).catch(() => null)
  ])
  return { cwd, args: cmdline.replace(/\0+$/, '').replace(/\0/g, ' ') || null, ...parseEnviron(environ), files: [fd1, fd2].filter((f): f is string => !!f) }
}

const exec = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 3_000 }, (_err, stdout) => resolve(String(stdout ?? ''))))

async function macProbe(pid: number): ReturnType<Probe> {
  const [lsof, args] = await Promise.all([exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd,1,2', '-Fn']), exec('ps', ['-o', 'args=', '-p', String(pid)])])
  let fd = ''
  let cwd: string | null = null
  const files: string[] = []
  for (const line of lsof.split('\n')) {
    if (line.startsWith('f')) fd = line.slice(1)
    else if (line.startsWith('n')) {
      if (fd === 'cwd') cwd = line.slice(1)
      else if (fd === '1' || fd === '2') files.push(line.slice(1))
    }
  }
  return { cwd, args: args.trim() || null, threadId: null, claudePid: null, files }
}

export interface SweepDeps {
  resources: Pick<ThreadResources, 'record' | 'live'>
  environmentId: string
  scanner: SharedScanner
  /** The host's unarchived threads (asked only when a listener is new). */
  threads: () => Omit<SweepThread, 'harnessStartedAt'>[]
  /** Whether any harness runs: the timer sweeps only then. */
  anyLive: () => boolean
  /** A port the Dev Server button's runs hold (devRuns.ts). */
  claimed: (port: number) => boolean
  /** A row was recorded: the live-row watch starts (threadPorts.ts). */
  recorded?: () => void
  ownPid?: number
  home?: string
  platform?: NodeJS.Platform
  probe?: Probe
  now?: () => number
  log?: (line: string) => void
}

export interface SweepReport {
  port: number
  pid: number
  /** The listener's command line, else its process name. */
  process: string
  cwd: string | null
  verdict: Verdict | { skip: 'on the ledger' | 'a Dev Server run'; final: true }
}

interface Decided {
  at: number
  final: boolean
}

interface ShellCall {
  callId: string
  command: string
  at: number
}

export class PortSweep {
  private readonly decided = new Map<string, Decided>()
  private readonly files = new Map<string, CallRef>()
  private readonly calls = new Map<string, ShellCall[]>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly probe: Probe
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null
  private running: Promise<SweepReport[]> | null = null

  constructor(private readonly deps: SweepDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[ports] ${line}`))
    this.probe = deps.probe ?? ((deps.platform ?? process.platform) === 'linux' ? linuxProbe : macProbe)
  }

  /** Shell calls and the output files they name, from the event stream. */
  observeEvent(row: EventRow): void {
    const ev = row.event
    if (ev.type === 'tool-call') {
      if (ev.partial) return
      const shell = shellOf(ev.input)
      if (!shell) return
      const command = shell.command ?? shell.argv?.join(' ') ?? ''
      const list = this.calls.get(row.sessionId) ?? []
      list.push({ callId: ev.callId, command, at: row.ts || this.now() })
      if (list.length > 20) list.shift()
      this.calls.set(row.sessionId, list)
      for (const p of outputPaths(command)) this.noteFile(p, { sessionId: row.sessionId, callId: ev.callId })
      return
    }
    if (ev.type === 'tool-result' && typeof ev.output === 'string' && this.calls.get(row.sessionId)?.some((c) => c.callId === ev.callId))
      for (const p of outputPaths(ev.output)) this.noteFile(p, { sessionId: row.sessionId, callId: ev.callId })
  }

  private noteFile(path: string, ref: CallRef): void {
    this.files.delete(path)
    this.files.set(path, ref)
    if (this.files.size > 500) this.files.delete(this.files.keys().next().value as string)
  }

  /** The output file a shell call named (portLog.ts reads it when the process no longer points there). */
  fileOfCall(callId: string): string | null {
    let found: string | null = null
    for (const [path, ref] of this.files) if (ref.callId === callId) found = path
    return found
  }

  /** The output file the CLI named for a background task (`…/tasks/<taskId>.output`), as a call's text noted it. */
  fileOfTask(taskId: string): string | null {
    const tail = `/tasks/${taskId}.output`
    let found: string | null = null
    for (const path of this.files.keys()) if (path.endsWith(tail)) found = path
    return found
  }

  /** A shell call settled: sweep once its server has had a moment to bind. */
  callEnded(): void {
    if (this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.sweep()
    }, SETTLE_SWEEP_MS)
    this.soon.unref?.()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.deps.anyLive()) void this.sweep()
    }, SWEEP_MS)
    this.timer.unref?.()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = this.soon = null
  }

  /** The shell call a credited server most likely came from: the latest before it started naming its port, else the latest before it started. */
  private callFor(sessionId: string, port: number, startedAt: number | null): { call: ShellCall; named: boolean } | null {
    const list = (this.calls.get(sessionId) ?? []).filter((c) => startedAt === null || c.at <= startedAt + 2_000)
    const named = list.findLast((c) => new RegExp(`(?<!\\d)${port}(?!\\d)`).test(c.command))
    if (named) return { call: named, named: true }
    const last = list.at(-1)
    return last ? { call: last, named: false } : null
  }

  /**
   * One pass. Listeners already decided are skipped without a read; a dry run
   * decides every listener again and records nothing.
   */
  sweep(opts: { dryRun?: boolean } = {}): Promise<SweepReport[]> {
    if (opts.dryRun) return this.pass(true)
    this.running ??= this.pass(false).finally(() => (this.running = null))
    return this.running
  }

  private async pass(dryRun: boolean): Promise<SweepReport[]> {
    const scan = await this.deps.scanner.get(dryRun ? 0 : 1_000)
    if (!scan.listeners.length) return []
    const now = this.now()
    const ports = byPort(scan.listeners)
    const present = new Set([...ports.values()].map((l) => `${l.port}/${l.pid}`))
    if (!dryRun) for (const key of this.decided.keys()) if (!present.has(key)) this.decided.delete(key)
    const fresh = [...ports.values()].filter((l) => {
      if (dryRun) return true
      const d = this.decided.get(`${l.port}/${l.pid}`)
      return !d || (!d.final && now - d.at >= RETRY_MS)
    })
    if (!fresh.length) return []

    const threads: SweepThread[] = this.deps.threads().map((t) => ({ ...t, harnessStartedAt: t.harnessPid ? (scan.started?.get(t.harnessPid) ?? null) : null }))
    const stops = new Set<number>([1, this.deps.ownPid ?? process.pid, ...threads.flatMap((t) => (t.harnessPid ? [t.harnessPid] : []))])
    const ctx: AttributeContext = {
      threads,
      fileOwner: (p) => this.files.get(p) ?? null,
      ownPid: this.deps.ownPid ?? process.pid,
      home: this.deps.home ?? process.env.HOME ?? ''
    }
    const probed = new Map<number, Promise<ProcInfo>>()
    const info = (pid: number): Promise<ProcInfo> => {
      let p = probed.get(pid)
      if (!p) {
        p = this.probe(pid).then((x) => ({ pid, ppid: scan.parents.get(pid) ?? null, startedAt: scan.started?.get(pid) ?? null, ...x }))
        probed.set(pid, p)
      }
      return p
    }

    const reports: SweepReport[] = []
    let recorded = false
    const decide = (key: string, final: boolean): void => {
      if (!dryRun) this.decided.set(key, { at: now, final })
    }
    for (const l of fresh) {
      const key = `${l.port}/${l.pid}`
      const base = { port: l.port, pid: l.pid }
      if (this.deps.resources.live(this.deps.environmentId, 'port', String(l.port))) {
        decide(key, true)
        reports.push({ ...base, process: l.command ?? '', cwd: null, verdict: { skip: 'on the ledger', final: true } })
        continue
      }
      if (this.deps.claimed(l.port)) {
        decide(key, true)
        reports.push({ ...base, process: l.command ?? '', cwd: null, verdict: { skip: 'a Dev Server run', final: true } })
        continue
      }
      // The listener's own facts only when the cheap checks pass; its ancestors only when it is not infrastructure.
      const quick = skipReason(l, [], ctx.ownPid)
      const chain: ProcInfo[] = []
      if (!quick) {
        let pid: number | null = l.pid
        for (let i = 0; pid !== null && i < CHAIN_DEPTH; i++) {
          chain.push(await info(pid))
          if (stops.has(pid)) break
          pid = scan.parents.get(pid) ?? null
          if (pid !== null && pid <= 1) break
        }
      }
      const verdict = quick ? ({ skip: quick, final: true } as const) : attribute(l, chain, ctx)
      decide(key, 'skip' in verdict ? verdict.final : true)
      reports.push({ ...base, process: serverCommand(chain, stops) ?? l.command ?? '', cwd: chain[0]?.cwd ?? null, verdict })
      if (dryRun || !('credit' in verdict)) continue
      const { sessionId, by } = verdict.credit
      const guess = verdict.credit.callId ? null : this.callFor(sessionId, l.port, chain[0]?.startedAt ?? null)
      const callId = verdict.credit.callId ?? guess?.call.callId ?? null
      // The call's command names the server when the call is known to be its; otherwise the process does.
      const named = verdict.credit.callId ? this.calls.get(sessionId)?.find((c) => c.callId === callId)?.command : guess?.named ? guess.call.command : null
      const listener = serverCommand(chain, stops) ?? l.command
      const label = portLabel(l.port, { command: named ?? listener, process: l.command })
      const made = this.deps.resources.record(sessionId, this.deps.environmentId, {
        created: [{ kind: 'port', identifier: String(l.port), label, branch: null, pid: l.pid, callId, what: listenerWords(listener, label) }],
        removed: []
      })
      if (made.length) {
        recorded = true
        this.log(`thread=${sessionId} port ${l.port} pid ${l.pid} by ${by}`)
      }
    }
    if (recorded) this.deps.recorded?.()
    return reports
  }
}

