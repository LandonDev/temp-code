import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_DEVICES_CALL_MS,
  HOST_DEVICES_FRESH_MS,
  HOST_DEVICES_GATHER_MS,
  HOST_DEVICES_INTERVAL_MS,
  HOST_DEVICES_OFFER,
  isHostDevicesPeerMethod,
  type DeviceHolder,
  type HostDevicesCallParams,
  type HostDevicesHost,
  type HostDevicesPeerMethod,
  type HostDevicesPush,
  type HostDevicesReport,
  type Phone,
  type Simulator,
  type XcodeInfo
} from '@shared/contract-hostdevices'
import type { ClientRequest, ServerPush } from '@shared/contract'
import { servePeerCall } from '../remote/peerCalls'
import {
  parseDevicectlDevices,
  parseSimctlDevices,
  parseSimulatorCpu,
  resolveXcode,
  type PhoneRow,
  type SimulatorRow
} from './parse'

/**
 * Devices on a Mac (docs/box.md "Devices on the Mac"): what the machine is
 * running for its threads, gathered only while someone is looking.
 *
 *  - `MacDevices` is the gatherer on the Mac: one pass runs `xcrun simctl
 *    list -j devices`, `xcrun devicectl list devices`, one `ps` for the
 *    booted simulators' CPU share, reads the load average and resolves the
 *    Xcode in use (parse.ts). A pass younger than HOST_DEVICES_FRESH_MS
 *    answers the next asker as is, and askers that overlap share one pass.
 *    It also performs the actions: simctl shutdown and delete, and opening
 *    Xcode's Devices and Simulators window.
 *  - `HostDevicesHub` sits on every host. It counts viewers per Mac and
 *    socket: the first viewer of a Mac starts a HOST_DEVICES_INTERVAL_MS
 *    timer that gathers (locally, or over the peer link with a
 *    `host.devices` peer.call) and pushes `host.devices` to each viewer;
 *    the last viewer leaving, or its socket closing, stops it. With no
 *    viewer nothing runs anywhere. On a host the Mac is linked to (the box),
 *    the hub also joins its own `thread_resources` rows for that Mac's
 *    simulators (ledger.ts) so a box thread's simulator names the box
 *    thread. On the Mac, the hub serves the same methods as peer calls
 *    under the `devices` offer, performing the actions itself.
 */

// ── holders ───────────────────────────────────────────────────────────

/** A live `thread_resources` row for a simulator (ledger.ts). */
export interface HolderRow {
  sessionId: string
  identifier: string
  label: string
}

/** The thread a row names, when this host runs it. */
export type SessionLookup = (sessionId: string) => { title: string; status: string } | null

/**
 * Each device's holder: the ledger row with its UDID, named by the thread's
 * title and status when this host knows the thread, else by the row's label.
 * `environmentId` says where the thread runs when the viewer is elsewhere.
 */
export function attachHolders<T extends { udid: string }>(
  rows: readonly T[],
  ledger: readonly HolderRow[],
  session: SessionLookup,
  environmentId?: string
): (T & { holder: DeviceHolder | null })[] {
  const byUdid = new Map(ledger.map((h) => [h.identifier.toUpperCase(), h]))
  return rows.map((row) => {
    const held = byUdid.get(row.udid.toUpperCase())
    if (!held) return { ...row, holder: null }
    const meta = session(held.sessionId)
    const holder: DeviceHolder = {
      sessionId: held.sessionId,
      title: meta?.title || held.label,
      ...(meta?.status ? { status: meta.status } : {}),
      ...(environmentId ? { environmentId } : {})
    }
    return { ...row, holder }
  })
}

// ── the gatherer on the Mac ───────────────────────────────────────────

export interface RunResult {
  stdout: string
  stderr: string
}
export type Runner = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<RunResult>

export interface MacDevicesDeps {
  environmentId: string
  env?: NodeJS.ProcessEnv
  run?: Runner
  /** Every /Applications/Xcode*.app. */
  listXcodes?: () => string[]
  readFile?: (path: string) => string | null
  /** A fresh path for devicectl's --json-output; removed after the read. */
  tempJson?: () => { path: string; done: () => void }
  loadavg?: () => number
  cores?: () => number
  /** This Mac's own ledger rows for its simulators. */
  ledger?: () => HolderRow[]
  session?: SessionLookup
  now?: () => number
  log?: (line: string) => void
}

const defaultRun: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ')
          reject(new Error(`${file} ${args[0] ?? ''} ${args[1] ?? ''}: ${tail || err.message}`.trim()))
        } else resolve({ stdout, stderr })
      }
    )
  })

const defaultListXcodes = (): string[] => {
  try {
    return readdirSync('/Applications')
      .filter((n) => /^Xcode[^/]*\.app$/.test(n))
      .map((n) => `/Applications/${n}`)
  } catch {
    return []
  }
}

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const defaultTempJson = (): { path: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-devicectl-'))
  return { path: join(dir, 'devices.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class MacDevices {
  private last: HostDevicesReport | null = null
  private inFlight: Promise<HostDevicesReport> | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly run: Runner
  private readonly listXcodes: () => string[]
  private readonly readFile: (path: string) => string | null
  private readonly tempJson: () => { path: string; done: () => void }
  private readonly loadavg: () => number
  private readonly cores: () => number
  private readonly ledger: () => HolderRow[]
  private readonly session: SessionLookup
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: MacDevicesDeps) {
    this.env = deps.env ?? process.env
    this.run = deps.run ?? defaultRun
    this.listXcodes = deps.listXcodes ?? defaultListXcodes
    this.readFile = deps.readFile ?? defaultReadFile
    this.tempJson = deps.tempJson ?? defaultTempJson
    this.loadavg = deps.loadavg ?? (() => loadavg()[0] ?? 0)
    this.cores = deps.cores ?? (() => cpus().length || 1)
    this.ledger = deps.ledger ?? (() => [])
    this.session = deps.session ?? (() => null)
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
  }

  /** The Xcode the tools use (parse.ts resolveXcode), resolved on every pass: a new install shows at once. */
  xcode(): XcodeInfo | null {
    let xcodeSelect: string | undefined
    const developerDir = this.env.DEVELOPER_DIR
    const apps = this.listXcodes()
    if (!developerDir && apps.length === 0) {
      // Only then is xcode-select worth a process: it is where ios-device.sh never looks.
      xcodeSelect = this.readFile('/private/var/db/xcode_select_link')?.trim() ?? undefined
    }
    return resolveXcode({
      ...(developerDir ? { developerDir } : {}),
      apps,
      ...(xcodeSelect ? { xcodeSelect } : {}),
      versionPlist: (app) => this.readFile(`${app}/Contents/version.plist`)
    })
  }

  /** The environment xcrun runs under: DEVELOPER_DIR pinned to the resolved Xcode, so every call uses the one the pane names. */
  private toolEnv(xcode: XcodeInfo | null): NodeJS.ProcessEnv {
    if (!xcode || this.env.DEVELOPER_DIR) return this.env
    return { ...this.env, DEVELOPER_DIR: `${xcode.path}/Contents/Developer` }
  }

  /** The report: fresh within HOST_DEVICES_FRESH_MS, else gathered now; overlapping askers share one pass. */
  report(opts: { fresh?: boolean } = {}): Promise<HostDevicesReport> {
    if (!opts.fresh && this.last && this.now() - this.last.at < HOST_DEVICES_FRESH_MS)
      return Promise.resolve(this.last)
    if (this.inFlight) return this.inFlight
    this.inFlight = this.gather().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async gather(): Promise<HostDevicesReport> {
    const started = this.now()
    const problems: string[] = []
    const xcode = this.xcode()
    const env = this.toolEnv(xcode)
    let sims: SimulatorRow[] = []
    let phones: PhoneRow[] = []
    const [simOut, phoneOut] = await Promise.all([
      this.run('xcrun', ['simctl', 'list', '-j', 'devices'], { env, timeoutMs: HOST_DEVICES_GATHER_MS }).then(
        (r) => r.stdout,
        (err) => {
          problems.push(`simulators: ${message(err)}`)
          return null
        }
      ),
      this.listPhones(env).catch((err) => {
        problems.push(`iPhones: ${message(err)}`)
        return null
      })
    ])
    if (simOut !== null) {
      try {
        sims = parseSimctlDevices(simOut)
      } catch (err) {
        problems.push(`simulators: ${message(err)}`)
      }
    }
    if (phoneOut !== null) {
      try {
        phones = parseDevicectlDevices(phoneOut)
      } catch (err) {
        problems.push(`iPhones: ${message(err)}`)
      }
    }
    const booted = sims.filter((s) => s.state === 'booted').map((s) => s.udid)
    const cpu = booted.length ? await this.simulatorCpu(booted, env) : new Map<string, number>()
    const ledger = this.ledger()
    const simulators: Simulator[] = attachHolders(sims, ledger, this.session).map((s) => {
      const share = cpu.get(s.udid)
      return share === undefined ? s : { ...s, cpu: share }
    })
    const phoneRows: Phone[] = attachHolders(phones, ledger, this.session)
    const report: HostDevicesReport = {
      environmentId: this.deps.environmentId,
      at: this.now(),
      simulators,
      phones: phoneRows,
      xcode,
      load: { oneMinute: Math.round(this.loadavg() * 100) / 100, cores: this.cores() },
      problems
    }
    this.last = report
    this.log(
      `gathered in ${this.now() - started} ms: ${simulators.length} simulators (${booted.length} booted), ${phoneRows.length} iPhones${problems.length ? `, problems: ${problems.join('; ')}` : ''}`
    )
    return report
  }

  private async listPhones(env: NodeJS.ProcessEnv): Promise<string> {
    const tmp = this.tempJson()
    try {
      await this.run(
        'xcrun',
        ['devicectl', 'list', 'devices', '--json-output', tmp.path, '--timeout', '10'],
        { env, timeoutMs: HOST_DEVICES_GATHER_MS }
      )
      const text = this.readFile(tmp.path)
      if (text === null) throw new Error('devicectl wrote no file')
      return text
    } finally {
      tmp.done()
    }
  }

  private async simulatorCpu(udids: string[], env: NodeJS.ProcessEnv): Promise<Map<string, number>> {
    try {
      const { stdout } = await this.run('ps', ['-axo', 'pid,pcpu,command'], { env, timeoutMs: 15_000 })
      return parseSimulatorCpu(stdout, udids)
    } catch (err) {
      this.log(`ps failed: ${message(err)}`)
      return new Map()
    }
  }

  // ── actions ────────────────────────────────────────────────────────

  async shutdown(udid: string): Promise<HostDevicesReport> {
    await this.simctl(['shutdown', udid])
    this.log(`shut down ${udid}`)
    return this.report({ fresh: true })
  }

  /** Deletes the simulator and its data; a booted one is shut down by simctl on the way. The renderer confirmed first. */
  async delete(udid: string): Promise<HostDevicesReport> {
    await this.simctl(['delete', udid])
    this.log(`deleted ${udid}`)
    return this.report({ fresh: true })
  }

  /** Opens Xcode's Devices and Simulators window: Xcode comes forward, then its Window menu item is clicked through System Events. */
  async openXcode(): Promise<{ ok: true; opened: 'devices' | 'xcode' }> {
    const xcode = this.xcode()
    if (!xcode) throw new Error('no Xcode under /Applications')
    await this.run('open', ['-a', xcode.path], { env: this.env, timeoutMs: 30_000 })
    try {
      await this.run(
        'osascript',
        [
          '-e',
          'tell application "Xcode" to activate',
          '-e',
          'tell application "System Events" to tell process "Xcode" to click menu item "Devices and Simulators" of menu "Window" of menu bar 1'
        ],
        { env: this.env, timeoutMs: 30_000 }
      )
      return { ok: true, opened: 'devices' }
    } catch (err) {
      // Without the accessibility permission System Events cannot click; Xcode is up, the person presses ⇧⌘2.
      this.log(`Devices window: ${message(err)}`)
      return { ok: true, opened: 'xcode' }
    }
  }

  private async simctl(args: string[]): Promise<void> {
    if (!/^[0-9A-Fa-f-]{36}$/.test(args[1] ?? '')) throw new Error('not a simulator UDID')
    await this.run('xcrun', ['simctl', ...args], { env: this.toolEnv(this.xcode()), timeoutMs: HOST_DEVICES_GATHER_MS })
  }
}

/** Whether this process runs on a Mac with Xcode's tools in reach. */
export const isMacHost = (platform: NodeJS.Platform = process.platform): boolean => platform === 'darwin'

/** The offer a Mac adds to its peer.register. */
export const hostDevicesOffers = (platform: NodeJS.Platform = process.platform): string[] =>
  isMacHost(platform) ? [HOST_DEVICES_OFFER] : []

// ── the hub on every host ─────────────────────────────────────────────

export interface HubPeers {
  registeredIds(offer: string): string[]
  call<T>(envId: string, method: HostDevicesPeerMethod, params: HostDevicesCallParams, deadlineMs: number): Promise<T>
}

export interface HostDevicesHubDeps {
  environmentId: string
  /** The gatherer when this host is a Mac; null elsewhere. */
  local: MacDevices | null
  peers: HubPeers
  hostName: (environmentId: string) => string | null
  /** This host's ledger rows for the simulators of a Mac (ledger.ts): a box thread's simulator on that Mac. */
  ledgerFor: (environmentId: string) => HolderRow[]
  session: SessionLookup
  /** The Mac's own name in the hosts list. */
  localName?: string
  intervalMs?: number
  /** Serving peer calls on the Mac: the link back to a host. */
  link?: (envId: string) => ((method: string, params: unknown) => Promise<unknown>) | null
  environments?: () => { id: string; name: string }[]
  log?: (line: string) => void
}

export interface Viewer {
  connection: number
  send: (push: ServerPush) => void
}

interface Watch {
  viewers: Map<number, Viewer>
  timer: ReturnType<typeof setInterval>
}

export class HostDevicesHub {
  private readonly watches = new Map<string, Watch>()
  private readonly log: (line: string) => void
  private readonly intervalMs: number

  constructor(private readonly deps: HostDevicesHubDeps) {
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
    this.intervalMs = deps.intervalMs ?? HOST_DEVICES_INTERVAL_MS
  }

  /** The Macs a viewer may watch: this one when it is a Mac, and every peer registered with the devices offer. */
  hosts(): HostDevicesHost[] {
    const out: HostDevicesHost[] = []
    if (this.deps.local)
      out.push({ environmentId: this.deps.environmentId, name: this.deps.localName ?? 'This Mac', local: true })
    for (const id of this.deps.peers.registeredIds(HOST_DEVICES_OFFER)) {
      if (id === this.deps.environmentId) continue
      out.push({ environmentId: id, name: this.deps.hostName(id) ?? id, local: false })
    }
    return out
  }

  /** Where a request goes: this Mac, or a registered one. */
  private resolve(target: string | undefined): { local: true; id: string } | { local: false; id: string } {
    const id = target ?? this.deps.environmentId
    if (id === this.deps.environmentId) {
      if (!this.deps.local) throw new Error('this host is not a Mac: name one with environmentId')
      return { local: true, id }
    }
    if (!this.deps.peers.registeredIds(HOST_DEVICES_OFFER).includes(id))
      throw new Error(`${this.deps.hostName(id) ?? id} is not linked right now`)
    return { local: false, id }
  }

  async report(target?: string, opts: { fresh?: boolean } = {}): Promise<HostDevicesReport> {
    const where = this.resolve(target)
    if (where.local) return this.deps.local!.report(opts)
    const remote = await this.deps.peers.call<HostDevicesReport>(where.id, 'host.devices', { args: {} }, HOST_DEVICES_CALL_MS)
    return this.withOwnHolders(remote)
  }

  /** A Mac's report with this host's own ledger joined: a thread here that holds a simulator there. */
  private withOwnHolders(report: HostDevicesReport): HostDevicesReport {
    const ledger = this.deps.ledgerFor(report.environmentId)
    if (ledger.length === 0) return report
    const join = <T extends { udid: string; holder: DeviceHolder | null }>(rows: T[]): T[] =>
      attachHolders(rows, ledger, this.deps.session, this.deps.environmentId).map((row, i) =>
        rows[i]!.holder ? rows[i]! : row
      )
    return { ...report, simulators: join(report.simulators), phones: join(report.phones) }
  }

  // ── viewers ────────────────────────────────────────────────────────

  /** Open a viewer on a socket: the report now, then a push every interval while it (or another) stays open. */
  async watch(viewer: Viewer, target?: string): Promise<HostDevicesReport> {
    const where = this.resolve(target)
    let watch = this.watches.get(where.id)
    if (!watch) {
      const timer = setInterval(() => void this.tick(where.id), this.intervalMs)
      timer.unref?.()
      watch = { viewers: new Map(), timer }
      this.watches.set(where.id, watch)
      this.log(`watching ${this.deps.hostName(where.id) ?? (where.local ? 'this Mac' : where.id)}`)
    }
    watch.viewers.set(viewer.connection, viewer)
    return this.report(where.id)
  }

  unwatch(connection: number, target?: string): void {
    const id = target ?? this.deps.environmentId
    const watch = this.watches.get(id)
    if (!watch) return
    watch.viewers.delete(connection)
    if (watch.viewers.size === 0) this.stop(id)
  }

  /** A socket closed: every viewer it held goes. */
  dropConnection(connection: number): void {
    for (const [id, watch] of this.watches) {
      if (!watch.viewers.delete(connection)) continue
      if (watch.viewers.size === 0) this.stop(id)
    }
  }

  /** Timers running right now (tests). */
  watching(): string[] {
    return [...this.watches.keys()]
  }

  private stop(id: string): void {
    const watch = this.watches.get(id)
    if (!watch) return
    clearInterval(watch.timer)
    this.watches.delete(id)
    this.log(`stopped watching ${this.deps.hostName(id) ?? id}`)
  }

  private async tick(id: string): Promise<void> {
    const watch = this.watches.get(id)
    if (!watch || watch.viewers.size === 0) return
    try {
      const report = await this.report(id, { fresh: true })
      const push: HostDevicesPush = { push: 'host.devices', report }
      for (const v of watch.viewers.values()) v.send(push)
    } catch (err) {
      this.log(`${this.deps.hostName(id) ?? id}: ${message(err)}`)
    }
  }

  // ── actions ────────────────────────────────────────────────────────

  async shutdown(target: string | undefined, udid: string): Promise<HostDevicesReport> {
    const where = this.resolve(target)
    if (where.local) return this.deps.local!.shutdown(udid)
    return this.withOwnHolders(
      await this.deps.peers.call<HostDevicesReport>(where.id, 'host.simulator.shutdown', { args: { udid } }, HOST_DEVICES_CALL_MS)
    )
  }

  async delete(target: string | undefined, udid: string): Promise<HostDevicesReport> {
    const where = this.resolve(target)
    if (where.local) return this.deps.local!.delete(udid)
    return this.withOwnHolders(
      await this.deps.peers.call<HostDevicesReport>(where.id, 'host.simulator.delete', { args: { udid } }, HOST_DEVICES_CALL_MS)
    )
  }

  async openXcode(target: string | undefined): Promise<{ ok: true; opened: 'devices' | 'xcode' }> {
    const where = this.resolve(target)
    if (where.local) return this.deps.local!.openXcode()
    return this.deps.peers.call(where.id, 'host.device.openXcode', { args: {} }, HOST_DEVICES_CALL_MS)
  }

  // ── serving a host's peer calls (the Mac) ──────────────────────────

  /** A push from a host: a host.* peer.call is served here and answered on the same link. */
  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isHostDevicesPeerMethod(push.method)) return false
    const request = this.deps.link?.(envId)
    if (!request) return true
    void servePeerCall(
      push,
      envId,
      (method, params) => this.handle(method as HostDevicesPeerMethod, params as HostDevicesCallParams, envId),
      request,
      this.log
    )
    return true
  }

  async handle(method: HostDevicesPeerMethod, params: HostDevicesCallParams, from: string): Promise<unknown> {
    if (this.deps.environments && !this.deps.environments().some((e) => e.id === from))
      throw new Error('this Mac does not know that host')
    if (!this.deps.local) throw new Error('this host is not a Mac')
    const udid = typeof params?.args?.udid === 'string' ? params.args.udid : ''
    switch (method) {
      case 'host.devices':
        return this.deps.local.report()
      case 'host.simulator.shutdown':
        return this.deps.local.shutdown(udid)
      case 'host.simulator.delete':
        return this.deps.local.delete(udid)
      case 'host.device.openXcode':
        return this.deps.local.openXcode()
    }
  }

  close(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }
}

// ── the contract methods ──────────────────────────────────────────────

/** The host.* requests on a socket; `socket` is the asking connection, for its viewers. */
export async function handleHostDevices(
  req: ClientRequest,
  hub: HostDevicesHub,
  socket: Viewer
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'host.devices.hosts':
      return { handled: true, result: hub.hosts() }
    case 'host.devices':
      return { handled: true, result: await hub.report(req.params?.environmentId) }
    case 'host.devices.watch':
      return { handled: true, result: await hub.watch(socket, req.params?.environmentId) }
    case 'host.devices.unwatch':
      hub.unwatch(socket.connection, req.params?.environmentId)
      return { handled: true, result: { ok: true } }
    case 'host.simulator.shutdown':
      return { handled: true, result: await hub.shutdown(req.params.environmentId, req.params.udid) }
    case 'host.simulator.delete':
      return { handled: true, result: await hub.delete(req.params.environmentId, req.params.udid) }
    case 'host.device.openXcode':
      return { handled: true, result: await hub.openXcode(req.params?.environmentId) }
    default:
      return { handled: false }
  }
}

/** Does the path exist (the default Xcode lookup's guard, exported for the dev-instance check in index.ts). */
export const hasXcodeTools = (): boolean => existsSync('/usr/bin/xcrun')
