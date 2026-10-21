import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostDevicesPeerMethod, HostDevicesReport } from '@shared/contract-hostdevices'
import type { ServerPush } from '@shared/contract'
import { HostDevicesHub, MacDevices, attachHolders, handleHostDevices, hostDevicesOffers, type HolderRow, type Runner } from './hostDevices'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const BOOTED = 'DC72C36B-03C7-4A69-B999-8DC4750E7D0D'
const MAC = 'env_MacMacMacMacMacMacMac1'
const BOX = 'env_BoxBoxBoxBoxBoxBoxBox1'

/** A runner that answers the fixtures and remembers every call. */
function fakeRunner(opts: { simctl?: string; devicectl?: string; ps?: string } = {}) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  let written: string | null = null
  const run: Runner = async (file, args, { env }) => {
    calls.push({ file, args, env })
    if (file === 'xcrun' && args[0] === 'simctl' && args[1] === 'list')
      return { stdout: opts.simctl ?? fixture('simctl-devices-booted.json'), stderr: '' }
    if (file === 'xcrun' && args[0] === 'devicectl') {
      written = opts.devicectl ?? fixture('devicectl-devices.json')
      return { stdout: '', stderr: '' }
    }
    if (file === 'ps') return { stdout: opts.ps ?? fixture('ps-simulators.txt'), stderr: '' }
    if (file === 'xcrun' && args[0] === 'simctl') return { stdout: '', stderr: '' }
    if (file === 'open' || file === 'osascript') return { stdout: '', stderr: '' }
    throw new Error(`unexpected ${file} ${args.join(' ')}`)
  }
  return { run, calls, readWritten: () => written }
}

function macDevices(runner = fakeRunner(), extra: Partial<ConstructorParameters<typeof MacDevices>[0]> = {}) {
  let now = 1_000_000
  const dev = new MacDevices({
    environmentId: MAC,
    env: {},
    run: runner.run,
    listXcodes: () => ['/Applications/Xcode-beta.app'],
    readFile: (path) => (path.endsWith('version.plist') ? fixture('xcode-version.plist') : runner.readWritten()),
    tempJson: () => ({ path: '/tmp/x.json', done: () => {} }),
    loadavg: () => 44.97,
    cores: () => 16,
    now: () => now,
    log: () => {},
    ...extra
  })
  return { dev, tick: (ms: number) => (now += ms) }
}

describe('MacDevices (the gatherer)', () => {
  it('one pass: simctl, devicectl and ps for the booted ones, under the resolved Xcode', async () => {
    const runner = fakeRunner()
    const { dev } = macDevices(runner)
    const report = await dev.report()
    expect(report.environmentId).toBe(MAC)
    expect(report.xcode).toEqual({ path: '/Applications/Xcode-beta.app', name: 'Xcode-beta', version: '27.0', from: 'newest' })
    expect(report.load).toEqual({ oneMinute: 44.97, cores: 16 })
    expect(report.simulators.map((s) => [s.name, s.state, s.cpu, s.holder])).toEqual([
      ['iPhone 17 Pro', 'booted', 0, null],
      ['TempCode proof', 'other', undefined, null],
      ['iPad Pro 13-inch (M4)', 'shutdown', undefined, null]
    ])
    expect(report.phones.map((p) => [p.model, p.connection])).toEqual([
      ['iPhone 17 Pro Max', 'paired'],
      ['iPad Pro 13-inch (M4)', 'unavailable']
    ])
    expect(report.problems).toEqual([])
    const files = runner.calls.map((c) => `${c.file} ${c.args.slice(0, 2).join(' ')}`)
    expect(files).toEqual(['xcrun simctl list', 'xcrun devicectl list', 'ps -axo pid,pcpu,command'])
    for (const c of runner.calls) expect(c.env.DEVELOPER_DIR).toBe('/Applications/Xcode-beta.app/Contents/Developer')
  })

  it('no booted simulator: no ps', async () => {
    const runner = fakeRunner({ simctl: fixture('simctl-devices-empty.json') })
    const { dev } = macDevices(runner)
    const report = await dev.report()
    expect(report.simulators).toEqual([])
    expect(runner.calls.some((c) => c.file === 'ps')).toBe(false)
  })

  it('a fresh report answers again without running anything; overlapping askers share one pass', async () => {
    const runner = fakeRunner()
    const { dev, tick } = macDevices(runner)
    const [a, b] = await Promise.all([dev.report(), dev.report()])
    expect(a).toBe(b)
    expect(runner.calls.filter((c) => c.args[0] === 'simctl' && c.args[1] === 'list').length).toBe(1)
    tick(2_000)
    expect(await dev.report()).toBe(a)
    tick(10_000)
    expect(await dev.report()).not.toBe(a)
    expect(runner.calls.filter((c) => c.args[0] === 'simctl' && c.args[1] === 'list').length).toBe(2)
  })

  it('a tool that fails is a problem line, the rest of the report stands', async () => {
    const base = fakeRunner()
    const run: Runner = async (file, args, opts) => {
      if (file === 'xcrun' && args[0] === 'devicectl') throw new Error('xcrun devicectl list: Timed out')
      return base.run(file, args, opts)
    }
    const { dev } = macDevices({ ...base, run })
    const report = await dev.report()
    expect(report.simulators.length).toBe(3)
    expect(report.phones).toEqual([])
    expect(report.problems).toEqual(['iPhones: xcrun devicectl list: Timed out'])
  })

  it('names the holder from this Mac’s ledger: the thread’s title and status when known, else the label', async () => {
    const { dev } = macDevices(fakeRunner(), {
      ledger: () => [
        { sessionId: 's1', identifier: BOOTED.toLowerCase(), label: 'iPhone 17 Pro (proof)' },
        { sessionId: 's2', identifier: '0E4D3C2B-1A09-4F8E-B7C6-D5E4F3A2B1C0', label: 'TempCode proof' }
      ],
      session: (id) => (id === 's1' ? { title: 'iOS: Home', status: 'running' } : null)
    })
    const report = await dev.report()
    expect(report.simulators[0]!.holder).toEqual({ sessionId: 's1', title: 'iOS: Home', status: 'running' })
    expect(report.simulators[1]!.holder).toEqual({ sessionId: 's2', title: 'TempCode proof' })
    expect(report.simulators[2]!.holder).toBeNull()
  })

  it('shutdown and delete run simctl on the UDID and answer a fresh report; a non-UDID is refused', async () => {
    const runner = fakeRunner()
    const { dev } = macDevices(runner)
    await dev.report()
    await dev.shutdown(BOOTED)
    await dev.delete(BOOTED)
    const simctl = runner.calls.filter((c) => c.args[0] === 'simctl').map((c) => c.args.slice(1).join(' '))
    expect(simctl).toEqual(['list -j devices', `shutdown ${BOOTED}`, 'list -j devices', `delete ${BOOTED}`, 'list -j devices'])
    await expect(dev.shutdown('../../etc')).rejects.toThrow('not a simulator UDID')
    expect(runner.calls.filter((c) => c.args[1] === 'shutdown').length).toBe(1)
  })

  it('opens Xcode and clicks its Devices and Simulators item; without accessibility, Xcode alone', async () => {
    const runner = fakeRunner()
    const { dev } = macDevices(runner)
    expect(await dev.openXcode()).toEqual({ ok: true, opened: 'devices' })
    expect(runner.calls.map((c) => c.file)).toEqual(['open', 'osascript'])
    expect(runner.calls[0]!.args).toEqual(['-a', '/Applications/Xcode-beta.app'])
    const refusing: Runner = async (file, args, opts) => {
      if (file === 'osascript') throw new Error('osascript is not allowed assistive access')
      return runner.run(file, args, opts)
    }
    const { dev: dev2 } = macDevices({ ...runner, run: refusing })
    expect(await dev2.openXcode()).toEqual({ ok: true, opened: 'xcode' })
  })

  it('the devices offer is a Mac’s only', () => {
    expect(hostDevicesOffers('darwin')).toEqual(['devices'])
    expect(hostDevicesOffers('linux')).toEqual([])
  })
})

describe('attachHolders', () => {
  it('joins by UDID, case-blind, and says where the thread runs when asked', () => {
    const rows = attachHolders(
      [{ udid: 'AAA' }, { udid: 'BBB' }],
      [{ sessionId: 's9', identifier: 'aaa', label: 'proof sim' }],
      (id) => (id === 's9' ? { title: 'iOS: Home', status: 'idle' } : null),
      BOX
    )
    expect(rows).toEqual([
      { udid: 'AAA', holder: { sessionId: 's9', title: 'iOS: Home', status: 'idle', environmentId: BOX } },
      { udid: 'BBB', holder: null }
    ])
  })
})

/** A hub with a fake Mac behind the peer link, or a local gatherer. */
function hub(opts: { local?: MacDevices | null; registered?: string[]; ledger?: HolderRow[] } = {}) {
  const calls: { envId: string; method: HostDevicesPeerMethod; udid?: string }[] = []
  let remoteReport: HostDevicesReport = {
    environmentId: MAC,
    at: 1,
    simulators: [
      { udid: BOOTED, name: 'iPhone 17 Pro', runtime: 'iOS 27.0', state: 'booted', cpu: 12, holder: null },
      { udid: 'CCC', name: 'Other', runtime: 'iOS 27.0', state: 'shutdown', holder: { sessionId: 'm1', title: 'Mac thread' } }
    ],
    phones: [],
    xcode: null,
    load: { oneMinute: 2.1, cores: 10 },
    problems: []
  }
  const h = new HostDevicesHub({
    environmentId: BOX,
    local: opts.local ?? null,
    peers: {
      registeredIds: () => opts.registered ?? [MAC],
      call: async <T,>(envId: string, method: HostDevicesPeerMethod, params: { args: { udid?: string } }) => {
        calls.push({ envId, method, ...(params.args.udid ? { udid: params.args.udid } : {}) })
        return remoteReport as T
      }
    },
    hostName: (id) => (id === MAC ? 'Landon’s Mac' : null),
    ledgerFor: (id) => (id === MAC ? (opts.ledger ?? []) : []),
    session: (id) => (id === 'b1' ? { title: 'iOS: Home', status: 'running' } : null),
    intervalMs: 30_000,
    log: () => {}
  })
  return { hub: h, calls, setRemote: (r: HostDevicesReport) => (remoteReport = r) }
}

describe('HostDevicesHub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('lists the Macs: itself when it is one, and every peer registered with the devices offer', () => {
    expect(hub().hub.hosts()).toEqual([{ environmentId: MAC, name: 'Landon’s Mac', local: false }])
    const { dev } = macDevices()
    const local = new HostDevicesHub({
      environmentId: MAC,
      local: dev,
      peers: { registeredIds: () => [], call: async () => ({}) as never },
      hostName: () => null,
      ledgerFor: () => [],
      session: () => null,
      log: () => {}
    })
    expect(local.hosts()).toEqual([{ environmentId: MAC, name: 'This Mac', local: true }])
  })

  it('a report of a registered Mac rides the peer link and gets this host’s own holders joined', async () => {
    const { hub: h, calls } = hub({ ledger: [{ sessionId: 'b1', identifier: BOOTED, label: 'proof' }] })
    const report = await h.report(MAC)
    expect(calls).toEqual([{ envId: MAC, method: 'host.devices' }])
    expect(report.simulators[0]!.holder).toEqual({ sessionId: 'b1', title: 'iOS: Home', status: 'running', environmentId: BOX })
    // The Mac's own holder stands.
    expect(report.simulators[1]!.holder).toEqual({ sessionId: 'm1', title: 'Mac thread' })
  })

  it('refuses a Mac that is not linked, and the box itself', async () => {
    const { hub: h } = hub({ registered: [] })
    await expect(h.report(MAC)).rejects.toThrow('Landon’s Mac is not linked right now')
    await expect(h.report()).rejects.toThrow('not a Mac')
  })

  it('watch: the first viewer starts the 30 s timer, pushes go to every viewer, the last leaving stops it', async () => {
    const { hub: h, calls } = hub()
    const got: ServerPush[] = []
    const a = { connection: 1, send: (p: ServerPush) => got.push(p) }
    const b = { connection: 2, send: (p: ServerPush) => got.push(p) }
    await h.watch(a, MAC)
    await h.watch(b, MAC)
    expect(h.watching()).toEqual([MAC])
    expect(calls.length).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.length).toBe(3)
    expect(got.length).toBe(2)
    expect(got[0]).toMatchObject({ push: 'host.devices', report: { environmentId: MAC } })
    h.unwatch(1, MAC)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.length).toBe(4)
    expect(got.length).toBe(3)
    h.unwatch(2, MAC)
    expect(h.watching()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.length).toBe(4)
    expect(got.length).toBe(3)
  })

  it('a socket closing drops its viewers; nothing runs with no one looking', async () => {
    const { hub: h, calls } = hub()
    await h.watch({ connection: 7, send: () => {} }, MAC)
    h.dropConnection(7)
    expect(h.watching()).toEqual([])
    await vi.advanceTimersByTimeAsync(90_000)
    expect(calls.length).toBe(1)
  })

  it('a tick that fails keeps the timer and the viewers', async () => {
    const { hub: h, setRemote } = hub()
    const got: ServerPush[] = []
    await h.watch({ connection: 1, send: (p) => got.push(p) }, MAC)
    setRemote(null as never)
    const fail = vi.spyOn(h as never as { report: () => Promise<unknown> }, 'report').mockRejectedValueOnce(new Error('link down'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(got.length).toBe(0)
    fail.mockRestore()
    expect(h.watching()).toEqual([MAC])
  })

  it('actions on a registered Mac go over the link with the UDID', async () => {
    const { hub: h, calls } = hub()
    await h.shutdown(MAC, BOOTED)
    await h.delete(MAC, BOOTED)
    await h.openXcode(MAC)
    expect(calls).toEqual([
      { envId: MAC, method: 'host.simulator.shutdown', udid: BOOTED },
      { envId: MAC, method: 'host.simulator.delete', udid: BOOTED },
      { envId: MAC, method: 'host.device.openXcode' }
    ])
  })

  it('on the Mac, a host’s peer call is served by the local gatherer, only from a known host', async () => {
    const runner = fakeRunner()
    const { dev } = macDevices(runner)
    const h = new HostDevicesHub({
      environmentId: MAC,
      local: dev,
      peers: { registeredIds: () => [], call: async () => ({}) as never },
      hostName: () => null,
      ledgerFor: () => [],
      session: () => null,
      environments: () => [{ id: BOX, name: 'box' }],
      log: () => {}
    })
    const report = (await h.handle('host.devices', { args: {} }, BOX)) as HostDevicesReport
    expect(report.simulators.length).toBe(3)
    await h.handle('host.simulator.shutdown', { args: { udid: BOOTED } }, BOX)
    expect(runner.calls.some((c) => c.args[1] === 'shutdown' && c.args[2] === BOOTED)).toBe(true)
    await expect(h.handle('host.devices', { args: {} }, 'env_Stranger')).rejects.toThrow('does not know that host')
    // Not a Mac: no peer serving.
    expect(hub().hub.onPeerPush(BOX, { push: 'macBridge.request', request: {} as never })).toBe(false)
  })

  it('the contract methods: hosts, a watch on the asking socket, unwatch, the actions', async () => {
    const { hub: h, calls } = hub()
    const socket = { connection: 3, send: () => {} }
    const ask = (req: Parameters<typeof handleHostDevices>[0]) => handleHostDevices(req, h, socket)
    expect(await ask({ id: '1', method: 'host.devices.hosts', params: {} })).toEqual({
      handled: true,
      result: [{ environmentId: MAC, name: 'Landon’s Mac', local: false }]
    })
    const watched = await ask({ id: '2', method: 'host.devices.watch', params: { environmentId: MAC } })
    expect(watched.handled && (watched.result as HostDevicesReport).environmentId).toBe(MAC)
    expect(h.watching()).toEqual([MAC])
    expect(await ask({ id: '3', method: 'host.devices.unwatch', params: { environmentId: MAC } })).toEqual({ handled: true, result: { ok: true } })
    expect(h.watching()).toEqual([])
    await ask({ id: '4', method: 'host.simulator.delete', params: { environmentId: MAC, udid: BOOTED } })
    expect(calls.at(-1)).toEqual({ envId: MAC, method: 'host.simulator.delete', udid: BOOTED })
    expect(await ask({ id: '5', method: 'catalog.get' })).toEqual({ handled: false })
  })
})
