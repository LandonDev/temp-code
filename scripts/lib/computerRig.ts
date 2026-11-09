/**
 * The computer rig (scripts/compare-computer-words.ts, scripts/e2e-computer-bench.ts):
 * the in-process server wired as index.ts wires it on a Mac, on the real
 * tc-computer, with scratch apps launched in the background and every query
 * for them pinned to their pids, per lane, so several models can work side by
 * side and none ever reaches the person's own windows. It records each
 * computer call as ComputerSessions.run saw it (the host time, its step lines,
 * its shots) and reads end states through its own service session, never
 * through a thread.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunningServer } from '../../src/main/server/index'
import { computerHooks, type ComputerHost } from '../../src/main/server/computer/mcp'
import { ComputerRpcError } from '../../src/main/server/computer/connection'
import type { ComputerSessions } from '../../src/main/server/computer/sessions'
import { setSessionTierGate, type SessionTierGate } from '../../src/main/server/computer/tierGate'
import { parseObservation, type ParsedObservation } from '../../src/shared/computer/observation'
import type { AppRef, ComputerMethod, ComputerParams, ComputerResult, StepResult } from '../../src/shared/computer/protocol'
import type { HostCall, MacProbe } from './benchRun'
import { keepFront } from './benchRun'
import { exec } from './benchChecks'
import type { TaskApp, TaskReader } from './computerTasks'

/**
 * The checkout a rig script runs in: the first folder up from `from` holding
 * the repo's package.json. A script bundled into scripts/.out/ sits two
 * levels down, so its own file's parent is scripts/, not the root.
 */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'temp-code') return dir
    if (dirname(dir) === dir) throw new Error(`no temp-code checkout above ${from}`)
  }
}

// ── the apps ────────────────────────────────────────────────────────────

/** What a model may call each scratch app; a query matching nothing pinned goes through the normal match. */
export const RIG_QUERIES: Readonly<Record<TaskApp, readonly string[]>> = {
  TextEdit: ['textedit', 'com.apple.textedit'],
  'Google Chrome': ['google chrome', 'chrome', 'com.google.chrome'],
  Electron: ['electron', 'com.github.electron', 'tempcode', 'temp-code'],
  'System Settings': ['system settings', 'system preferences', 'settings', 'com.apple.systempreferences']
}
export const RIG_BUNDLES: Readonly<Record<TaskApp, string>> = {
  TextEdit: 'com.apple.TextEdit',
  'Google Chrome': 'com.google.Chrome',
  Electron: 'com.github.Electron',
  'System Settings': 'com.apple.systempreferences'
}
/** The process name pgrep finds each by. */
const PROCESS: Readonly<Record<TaskApp, string>> = { TextEdit: 'TextEdit', 'Google Chrome': 'Google Chrome', Electron: 'Electron', 'System Settings': 'System Settings' }

/**
 * The one launcher's arguments, the spec's fixture recording's (docs/computer-protocol.md
 * §10.1): Chrome as a second instance on its own profile with the renderer's
 * accessibility forced on (else the page never reaches the AX tree); TextEdit
 * as a separate instance on a file under /tmp that restores none of the
 * person's documents, never saves to iCloud and adds nothing to Open Recent;
 * System Settings in the background (it runs one instance).
 */
export function scratchArgs(app: TaskApp, target: string, chromeProfile: string): string[] {
  switch (app) {
    case 'TextEdit':
      return ['-n', '-g', '-a', 'TextEdit', target, '--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-NSDocumentSaveNewDocumentsToCloud', 'NO']
    case 'Google Chrome':
      return ['-n', '-g', '-a', 'Google Chrome', '--args', `--user-data-dir=${chromeProfile}`, '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', target]
    case 'System Settings':
      return ['-g', '-b', RIG_BUNDLES['System Settings'], ...(target ? [target] : [])]
    case 'Electron':
      throw new Error('the dev instance is started by its task, not by open')
  }
}

// ── lanes ───────────────────────────────────────────────────────────────

/** The lane a thread not bound to one works in: the comparison's only lane. */
export const DEFAULT_LANE = 'main'

/**
 * Pins per lane. resolveApp is asked with the query alone, so the call
 * wrapper runs each thread's call inside its lane's scope (AsyncLocalStorage
 * carries it through the thread's queue), and a query resolves to that
 * lane's scratch pid only.
 */
export class LanePins {
  private readonly pins = new Map<string, Map<TaskApp, number>>()
  private readonly lanes = new Map<string, string>()
  private readonly scope = new AsyncLocalStorage<string>()

  bind(threadId: string, lane: string): void {
    this.lanes.set(threadId, lane)
  }
  unbind(threadId: string): void {
    this.lanes.delete(threadId)
  }
  pin(lane: string, app: TaskApp, pid: number): void {
    const m = this.pins.get(lane) ?? new Map<TaskApp, number>()
    m.set(app, pid)
    this.pins.set(lane, m)
  }
  unpin(lane: string, app?: TaskApp): void {
    if (app) this.pins.get(lane)?.delete(app)
    else this.pins.delete(lane)
  }
  pinned(lane: string, app: TaskApp): number | undefined {
    return this.pins.get(lane)?.get(app)
  }
  /** Every pid a lane has pinned. */
  pids(lane: string): number[] {
    return [...(this.pins.get(lane)?.values() ?? [])]
  }
  /** Runs `fn` in the scope of the thread's lane. */
  within<T>(threadId: string, fn: () => T): T {
    return this.scope.run(this.lanes.get(threadId) ?? DEFAULT_LANE, fn)
  }
  resolve(query: string): AppRef | null {
    const lane = this.scope.getStore() ?? DEFAULT_LANE
    const q = query.trim().toLowerCase()
    for (const app of Object.keys(RIG_QUERIES) as TaskApp[]) {
      const pid = this.pinned(lane, app)
      if (pid && RIG_QUERIES[app].includes(q)) return { pid }
    }
    return null
  }
}

/**
 * Wraps `sessions.run` so each call is recorded under its thread: its start,
 * its host time (entering run to its outcome, the thread's queue wait
 * inside), its step lines, its shots, isError. Claude's in-process tools and
 * the bridge's app.computer both reach this one `run`.
 */
export function recordCalls(sessions: ComputerSessions, pins: LanePins, now: () => number = Date.now): { calls(threadId: string): HostCall[]; clear(threadId: string): void } {
  const byThread = new Map<string, HostCall[]>()
  const run = sessions.run.bind(sessions)
  sessions.run = (ctx, tool, args) => {
    const startedAt = now()
    const note = (call: Omit<HostCall, 'tool' | 'args' | 'startedAt' | 'hostMs'>): void => {
      const list = byThread.get(ctx.threadId) ?? []
      list.push({ tool, args, startedAt, hostMs: now() - startedAt, ...call })
      byThread.set(ctx.threadId, list)
    }
    return pins.within(ctx.threadId, () => run(ctx, tool, args)).then(
      (outcome) => {
        note({ steps: outcome.steps, shots: outcome.shots.length, isError: outcome.isError })
        return outcome
      },
      (err: unknown) => {
        note({ steps: [], shots: 0, isError: true })
        throw err
      }
    )
  }
  return { calls: (id) => [...(byThread.get(id) ?? [])], clear: (id) => void byThread.delete(id) }
}

// ── the Mac, read from outside ──────────────────────────────────────────

export interface MacReads {
  frontmost(): { pid: number; bundleId: string | null }
  pointer(): { x: number; y: number }
  idleSeconds(): number
  activate(bundleId: string): void
}

/** The probe's answers as the launch guard reads them. */
export const asProbe = (mac: MacReads): MacProbe => ({
  idleSeconds: async () => mac.idleSeconds(),
  frontmost: async () => mac.frontmost(),
  activate: async (id) => mac.activate(id)
})

// ── the rig ─────────────────────────────────────────────────────────────

export class RigStop extends Error {}

export interface Rig {
  server: RunningServer
  host: ComputerHost
  sessions: ComputerSessions
  pins: LanePins
  mac: MacReads
  /** what the threads' steps did, from the wire, since the last reset (the proof session left out) */
  wire: { steps: number; failed: number; kinds: Record<string, number> }
  resetWire(): void
  calls(threadId: string): HostCall[]
  /** a request on the rig's own service session, opened again after a service restart */
  proof<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>>
  /** the end state through the rig's own session, at the lane's pins */
  reader(lane: string): TaskReader
  /** launch a scratch app for the lane, pin it, and keep the person's app in front */
  launch(lane: string, app: TaskApp, target: string): Promise<{ pid: number; front: 'kept' | 'bounced' | 'took' }>
  /** SIGKILL every scratch pid of the lane, drop its pins and its Chrome profile */
  closeLane(lane: string): void
  close(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pidsOf = (name: string): Set<number> => {
  try {
    return new Set(execFileSync('pgrep', ['-x', name], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number))
  } catch {
    return new Set()
  }
}

/**
 * Builds tc-computer, compiles the probe, checks Accessibility (RigStop when
 * off: the rig asks for no permission), starts the server with the pins as
 * its resolveApp and sets the session tier's gate.
 */
export async function startRig(opts: { root: string; work: string; gate: SessionTierGate; proofSession: string; log?: (line: string) => void }): Promise<Rig> {
  // Loaded here, not at the top: the lanes and the call wrapper are tested without a server or a Swift build.
  const { startServer } = await import('../../src/main/server/index')
  const { buildTcComputer } = await import('./tcComputerBuild')
  const log = opts.log ?? ((line: string) => console.log(line))
  const bin = join(opts.root, 'resources/native/tc-computer')
  const probeBin = join(opts.work, 'computer-proof-probe')
  const build = buildTcComputer({ root: opts.root, require: true })
  log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
  execFileSync('xcrun', ['swiftc', '-O', '-o', probeBin, join(opts.root, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  const probe = <T>(command: string): T => JSON.parse(execFileSync(probeBin, [command], { encoding: 'utf8', timeout: 10_000 })) as T
  const mac: MacReads = {
    frontmost: () => probe('frontmost'),
    pointer: () => probe('pointer'),
    idleSeconds: () => probe<{ seconds: number }>('idle').seconds,
    activate: (bundleId) => void execFileSync('osascript', ['-e', `tell application id "${bundleId}" to activate`])
  }
  process.env.TEMP_CODE_COMPUTER_BIN = bin
  const grants = JSON.parse(execFileSync(bin, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean }
  if (!grants.accessibility) throw new RigStop('Accessibility is off for TempCode: turn it on under System Settings → Privacy & Security → Accessibility')

  const pins = new LanePins()
  const server = await startServer(join(opts.work, 'data', 'app.db'), {
    dataDir: join(opts.work, 'data'),
    claimShim: false,
    remotePort: 0,
    computerResolveApp: (q) => pins.resolve(q)
  })
  const host = computerHooks.current
  if (!host?.available()) throw new RigStop('computer use is unavailable in this server')
  setSessionTierGate(opts.gate)

  const wire = { steps: 0, failed: 0, kinds: {} as Record<string, number> }
  const request = host.service.request.bind(host.service)
  host.service.request = (async (method: ComputerMethod, params: never, o?: { signal?: AbortSignal; timeoutMs?: number }) => {
    try {
      const result = await request(method, params, o)
      const steps: StepResult[] = method === 'action.run' ? [(result as { step: StepResult }).step] : method === 'action.batch' ? (result as { steps: StepResult[] }).steps : []
      if ((params as { session?: string }).session !== opts.proofSession)
        for (const s of steps) {
          if (s.status === 'not-run') continue
          wire.steps++
          if (s.status === 'failed') {
            wire.failed++
            wire.kinds[s.error.kind] = (wire.kinds[s.error.kind] ?? 0) + 1
          }
        }
      return result
    } catch (e) {
      if (e instanceof ComputerRpcError && e.data) wire.kinds[e.data.kind] = (wire.kinds[e.data.kind] ?? 0) + 1
      throw e
    }
  }) as typeof host.service.request
  const recorded = recordCalls(host.sessions, pins)

  const proof = async <M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> => {
    try {
      return await request(method, params)
    } catch (e) {
      if (!(e instanceof ComputerRpcError) || e.data?.kind !== 'unknown_session') throw e
      await request('session.open', { session: opts.proofSession })
      return await request(method, params)
    }
  }
  await request('session.open', { session: opts.proofSession })
  const pidFor = (lane: string, app: TaskApp): number => {
    const pid = pins.pinned(lane, app)
    if (!pid) throw new Error(`no scratch ${app} in lane ${lane}`)
    return pid
  }
  const reader = (lane: string): TaskReader => ({
    read: async (app, window): Promise<ParsedObservation> =>
      parseObservation((await proof('state.get', { session: opts.proofSession, app: { pid: pidFor(lane, app) }, window: { title: window }, mode: 'full' })).text),
    element: async (app, window, index): Promise<ParsedObservation> =>
      parseObservation((await proof('state.get', { session: opts.proofSession, app: { pid: pidFor(lane, app) }, window: { title: window }, element: index })).text),
    exec
  })

  const profileOf = (lane: string): string => join(opts.work, `chrome-${lane}`)
  const launch = async (lane: string, app: TaskApp, target: string): Promise<{ pid: number; front: 'kept' | 'bounced' | 'took' }> => {
    const name = PROCESS[app]
    const before = pidsOf(name)
    const personFront = mac.frontmost()
    execFileSync('open', scratchArgs(app, target, profileOf(lane)))
    let pid: number | undefined
    for (let i = 0; i < 60 && !pid; i++) {
      await sleep(250)
      pid = [...pidsOf(name)].find((p) => !before.has(p))
    }
    if (!pid) throw new Error(`open gave no new ${name} pid`)
    pins.pin(lane, app, pid)
    await sleep(app === 'TextEdit' ? 1_000 : 3_000)
    return { pid, front: await keepFront(asProbe(mac), pid, personFront) }
  }
  const closeLane = (lane: string): void => {
    for (const pid of pins.pids(lane)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone already */
      }
    }
    pins.unpin(lane)
    rmSync(profileOf(lane), { recursive: true, force: true })
  }
  const lanes = new Set<string>()
  return {
    server,
    host,
    sessions: host.sessions,
    pins,
    mac,
    wire,
    resetWire: () => Object.assign(wire, { steps: 0, failed: 0, kinds: {} }),
    calls: (id) => recorded.calls(id),
    proof,
    reader,
    launch: async (lane, app, target) => {
      lanes.add(lane)
      return launch(lane, app, target)
    },
    closeLane,
    close: async () => {
      for (const lane of new Set([...lanes, DEFAULT_LANE])) closeLane(lane)
      await server.registry.disposeAll().catch(() => undefined)
    }
  }
}
