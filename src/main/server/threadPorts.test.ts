import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventRow, SessionMeta } from '@shared/events'
import { openDb } from './db'
import { ThreadResources } from './threadResources'
import { childBudget, onBudgetedSpawn } from './spawnBudget'
import { LIVE_MS, scanHost, SharedScanner, ThreadPorts, type Scan } from './threadPorts'
import type { Listener } from './threadPortsParse'
import { removeResource, type ResourceRunner } from './threadResourcesRemove'

const ME = 'env_box000000000000000000'
const HARNESS = 100

const session = (id: string, parentId: string | null = null): SessionMeta =>
  ({ id, parentId, title: `t ${id}`, cwd: '/srv/agents/work/x', permission: 'auto', archived: false }) as unknown as SessionMeta

describe('ThreadPorts', () => {
  let db: ReturnType<typeof openDb>
  let ledger: ThreadResources
  let ports: ThreadPorts
  let listeners: Listener[]
  let parents: Map<number, number>
  let args: Map<number, string>
  let now: number
  beforeEach(() => {
    db = openDb(':memory:')
    const sessions = new Map([['root', session('root')], ['child', session('child', 'root')]])
    now = 1_000_000
    ledger = new ThreadResources({ db, environmentId: ME, sessions: { get: (id) => sessions.get(id) ?? null }, runOn: async () => ({ exitCode: 0, stdout: '', stderr: '' }), now: () => now, log: () => {} })
    // The app's own listener (pid 1) and an MCP server under the harness (pid 150) from the start.
    listeners = [
      { port: 7677, pid: 1, address: '127.0.0.1', command: 'electron' },
      { port: 9999, pid: 150, address: '127.0.0.1', command: 'node' }
    ]
    parents = new Map([[1, 0], [HARNESS, 1], [150, HARNESS]])
    args = new Map()
    const scanner = new SharedScanner(async (): Promise<Scan> => ({ listeners: [...listeners], parents: new Map(parents), args: new Map(args) }), () => now)
    ports = new ThreadPorts({ resources: ledger, environmentId: ME, harnessPid: (id) => (id === 'child' || id === 'root' ? HARNESS : null), scanner, now: () => now, log: () => {} })
  })
  afterEach(() => {
    ports.close()
    db.close()
  })

  const call = (sessionId: string, callId: string, command: string): void =>
    ports.observeEvent({ sessionId, seq: 1, ts: 1, event: { type: 'tool-call', callId, name: 'Bash', input: { command } } } as EventRow)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const spawnServer = (port: number, pid: number, under = HARNESS) => {
    parents.set(pid, under)
    listeners.push({ port, pid, address: '*', command: 'node' })
  }

  it('records an announced port with its listener, under the top-level thread, tied to the call', async () => {
    call('child', 'c1', 'bun run dev > /tmp/log & sleep 2; cat /tmp/log')
    await flush()
    spawnServer(5173, 201)
    const rows = await ports.settle('child', 'c1', '  ➜  Local:   http://localhost:5173/\n')
    expect(rows).toMatchObject([{ kind: 'port', identifier: '5173', label: 'http://localhost:5173', pid: 201, callId: 'c1', sessionId: 'root' }])
  })

  it('names a port row from the process that listens', async () => {
    call('root', 'c1', 'bun src/server.ts')
    await flush()
    parents.set(202, HARNESS)
    listeners.push({ port: 4100, pid: 202, address: '*', command: 'bun src/server.ts' })
    const rows = await ports.settle('root', 'c1', 'Listening on http://localhost:4100\n')
    expect(rows).toMatchObject([{ identifier: '4100', what: 'Bun server' }])
  })

  it('never records an announcement nothing listens on', async () => {
    call('root', 'c1', 'cat old.log')
    await flush()
    expect(await ports.settle('root', 'c1', 'Local: http://localhost:5173/')).toEqual([])
  })

  it('records a new listener under the harness while a call runs, never the baseline or a stranger', async () => {
    call('root', 'c1', 'bun run serve')
    await flush()
    spawnServer(3000, 300)
    spawnServer(4000, 400, 1) // not under the harness
    now += 2_000
    await ports.tick()
    const rows = ledger.listAll({ kind: 'port' })
    expect(rows.map((r) => [r.identifier, r.pid, r.callId, r.label])).toEqual([['3000', 300, 'c1', 'bun run serve']])
  })

  it("never files an announced port whose listener runs under a test run or the gate", async () => {
    call('root', 'c1', 'bunx vitest run --browser')
    await flush()
    // vitest (pid 300) under the harness, a preview server (pid 301) under it, announcing itself.
    parents.set(300, HARNESS)
    args.set(300, 'node /srv/agents/work/x/node_modules/vitest/vitest.mjs run --browser')
    parents.set(301, 300)
    args.set(301, 'node /srv/agents/work/x/node_modules/vite/bin/vite.js preview')
    listeners.push({ port: 63315, pid: 301, address: '127.0.0.1', command: 'node' })
    const rows = await ports.settle('root', 'c1', '  ➜  Local:   http://localhost:63315/\n')
    expect(rows).toEqual([])
    expect(ledger.listAll({ kind: 'port' })).toEqual([])
  })

  it('never files a test run’s worker as a dev server', async () => {
    call('root', 'c1', 'NODE_ENV=test bunx vitest run src/x.test.ts')
    await flush()
    spawnServer(41234, 300)
    now += 2_000
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' })).toEqual([])
  })

  it("never files the merge gate's vitest worker under a call that did not name the gate: the runner is found above the listener", async () => {
    // The call ran a script; the script ran the gate; the gate's vitest forked a worker that listens.
    call('root', 'c1', './scripts/land.sh')
    await flush()
    parents.set(240, HARNESS)
    parents.set(250, 240)
    args.set(240, '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since 00bb5d7c288…')
    args.set(250, 'node /srv/agents/work/temp-code/node_modules/vitest/dist/cli.js run')
    args.set(300, 'node /srv/agents/work/temp-code/node_modules/tinypool/dist/entry/process.js')
    spawnServer(45649, 300, 250)
    now += 2_000
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' })).toEqual([])
    // A real server under the same call, with no runner above it, is filed.
    args.set(310, 'bun run dev')
    spawnServer(5173, 310)
    now += 2_000
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' }).map((r) => r.identifier)).toEqual(['5173'])
  })

  it('keeps polling for the grace period after the last call, then stops', async () => {
    call('root', 'c1', 'nohup bun run dev &')
    await flush()
    await ports.settle('root', 'c1', '')
    now += 5_000
    spawnServer(5174, 501)
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' }).map((r) => r.identifier)).toEqual(['5174'])
    now += 20_000
    spawnServer(5175, 502)
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' }).map((r) => r.identifier)).toEqual(['5174'])
  })

  it('ends a port that stopped listening on the first sweep, and follows a restart under the harness', async () => {
    call('root', 'c1', 'bun run dev')
    await flush()
    spawnServer(5173, 201)
    spawnServer(5180, 210)
    await ports.settle('root', 'c1', 'Local: http://localhost:5173/\nready on http://localhost:5180')
    // 5173's server restarted under a new pid (a watcher, still under the harness); 5180 went away.
    listeners = listeners.filter((l) => l.pid !== 201 && l.pid !== 210)
    parents.delete(201)
    parents.delete(210)
    spawnServer(5173, 202)
    now += GRACE_PAST
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' }).map((r) => [r.identifier, r.pid])).toEqual([['5173', 202]])
    expect(ledger.list('root', true).find((r) => r.identifier === '5180')?.note).toBe('stopped listening')
  })

  it("ends a row whose process is gone when the port's new listener is not the thread's", async () => {
    call('root', 'c1', 'bun run dev')
    await flush()
    spawnServer(5173, 201)
    await ports.settle('root', 'c1', 'Local: http://localhost:5173/')
    // 201 died; a stranger (under init, not the harness) took the port.
    listeners = listeners.filter((l) => l.pid !== 201)
    parents.delete(201)
    parents.set(900, 1)
    listeners.push({ port: 5173, pid: 900, address: '*', command: 'python' })
    now += GRACE_PAST
    await ports.tick()
    expect(ledger.listAll({ kind: 'port' })).toEqual([])
    expect(ledger.list('root', true).find((r) => r.identifier === '5173')?.note).toBe('its process is gone')
  })

  it('a row from before a restart whose server is gone leaves on the first sweep of the poll the host arms at boot', async () => {
    // The ledger as a restarted host finds it: a port row, pid 777 (reparented and dead), nothing listening.
    ledger.record('root', ME, { created: [{ kind: 'port', identifier: '5190', label: 'http://localhost:5190', branch: null, pid: 777, callId: 'old' }], removed: [] })
    expect(ledger.listAll({ kind: 'port' })).toHaveLength(1)
    vi.useFakeTimers()
    try {
      ports.arm()
      now += LIVE_MS
      await vi.advanceTimersByTimeAsync(LIVE_MS)
      expect(ledger.listAll({ kind: 'port' })).toEqual([])
      expect(ledger.list('root', true)[0]?.note).toBe('stopped listening')
    } finally {
      vi.useRealTimers()
    }
  })

  it('one live row per port on a host: a cluster listening on one port, and a second detection, make one row', async () => {
    call('root', 'c1', 'bun run dev')
    await flush()
    spawnServer(5173, 201)
    spawnServer(5173, 203)
    await ports.settle('root', 'c1', 'Local: http://localhost:5173/')
    call('child', 'c2', 'curl localhost:5173')
    await flush()
    await ports.settle('child', 'c2', 'Local: http://localhost:5173/')
    expect(ledger.listAll({ kind: 'port' }).map((r) => r.identifier)).toEqual(['5173'])
  })

  it('never stamps rows from a scan that saw no listeners at all', async () => {
    call('root', 'c1', 'bun run dev')
    await flush()
    spawnServer(5173, 201)
    await ports.settle('root', 'c1', 'Local: http://localhost:5173/')
    listeners = []
    for (let i = 0; i < 3; i++) {
      now += LIVE_MS
      await ports.tick()
    }
    expect(ledger.listAll({ kind: 'port' })).toHaveLength(1)
  })
})

const GRACE_PAST = 60_000

describe('removing a port', () => {
  const row = (pid: number | null) =>
    ({ id: 'r1', sessionId: 's', environmentId: ME, kind: 'port', identifier: '5173', label: 'x', branch: null, createdAt: 1, removeRequestedAt: null, removedAt: null, note: null, pid, callId: 'c1' }) as const
  const ssLine = (pid: number) => `LISTEN 0 511 *:5173 *:* users:(("node",pid=${pid},fd=20))`

  it('terms the pid that still holds the port', async () => {
    const runs: string[] = []
    let alive = true
    const run: ResourceRunner = async (argv) => {
      runs.push(argv.join(' '))
      if (argv[0] === 'ss') return { exitCode: 0, stdout: ssLine(42), stderr: '' }
      if (argv[1] === '-TERM') alive = false
      if (argv[1] === '-0') return { exitCode: alive ? 0 : 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    expect(await removeResource(row(42), run)).toEqual({ note: null })
    expect(runs).toEqual(['ss -ltnpH sport = :5173', 'kill -TERM 42', 'kill -0 42'])
  })

  it('kills one that ignores SIGTERM after the grace', async () => {
    let alive = true
    const run: ResourceRunner = async (argv) => {
      if (argv[0] === 'ss') return { exitCode: 0, stdout: ssLine(42), stderr: '' }
      if (argv[1] === '-KILL') alive = false
      if (argv[1] === '-0') return { exitCode: alive ? 0 : 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    expect(await removeResource(row(42), run)).toEqual({ note: 'killed after 3 s' })
  }, 10_000)

  it('touches nothing when another process holds the port now, and reads lsof without ss', async () => {
    const runs: string[] = []
    const run: ResourceRunner = async (argv) => {
      runs.push(argv[0])
      if (argv[0] === 'ss') return { exitCode: 127, stdout: '', stderr: 'not found' }
      if (argv[0] === 'lsof') return { exitCode: 0, stdout: 'node 77 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:5173 (LISTEN)', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    expect(await removeResource(row(42), run)).toEqual({ note: 'was already gone' })
    expect(runs).toEqual(['ss', 'lsof'])
  })
})

describe('ThreadPorts upkeep', () => {
  it('scans nothing when a call announced nothing, and forgets a call whose result never came', async () => {
    const db = openDb(':memory:')
    const ledger = new ThreadResources({ db, environmentId: ME, sessions: { get: () => session('root') }, runOn: async () => ({ exitCode: 0, stdout: '', stderr: '' }), log: () => {} })
    let scans = 0
    let now = 0
    const ports = new ThreadPorts({
      resources: ledger,
      environmentId: ME,
      harnessPid: () => HARNESS,
      scanner: new SharedScanner(async () => (scans++, { listeners: [], parents: new Map() }), () => now),
      now: () => now,
      log: () => {}
    })
    ports.callStarted('root', 'c1', 'ls')
    await new Promise((r) => setTimeout(r, 0))
    const baseline = scans
    expect(await ports.settle('root', 'c1', 'a\nb')).toEqual([])
    expect(scans).toBe(baseline)
    ports.callStarted('root', 'c2', 'sleep 9999')
    expect(ports.running('c2')).toBe(true)
    now += 31 * 60_000
    await ports.tick()
    expect(ports.running('c2')).toBe(false)
    ports.close()
    db.close()
  })
})

it('baselines for a burst of threads share the 500 ms scan', async () => {
  let now = 0
  const scan = vi.fn(async (): Promise<Scan> => ({ listeners: [], parents: new Map() }))
  const scanner = new SharedScanner(scan, () => now)
  const resources = { record: vi.fn(), listAll: () => [], live: () => null, ended: vi.fn(), setPid: vi.fn() }
  const ports = new ThreadPorts({ resources: resources as never, environmentId: ME, harnessPid: () => HARNESS, scanner })
  try {
    ports.callStarted('one', 'c1', 'echo one')
    ports.callStarted('two', 'c2', 'echo two')
    await scanner.get()
    expect(scan).toHaveBeenCalledTimes(1)
    now = 501
    ports.callStarted('three', 'c3', 'echo three')
    await scanner.get()
    expect(scan).toHaveBeenCalledTimes(2)
  } finally { ports.close() }
})

it('scanner children wait for helper slots', async () => {
  const releases = await Promise.all(Array.from({ length: childBudget.concurrency }, () => childBudget.acquire()))
  const spawned: string[] = []
  const off = onBudgetedSpawn((file) => spawned.push(file))
  const scanning = scanHost('linux')
  try {
    await Promise.resolve()
    expect(spawned).toEqual([])
    expect(childBudget.waiting).toBe(2)
  } finally { for (const release of releases) release() }
  await scanning
  off()
  expect(spawned.sort()).toEqual(['ps', 'ss'])
})

it('shares an in-flight scan even when its cache age has expired', async () => {
  let now = 0
  let finish!: (scan: Scan) => void
  const scan = vi.fn(() => new Promise<Scan>((resolve) => { finish = resolve }))
  const scanner = new SharedScanner(scan, () => now)
  const first = scanner.get()
  now = 1000
  expect(scanner.get()).toBe(first)
  expect(scanner.get(0)).toBe(first)
  expect(scan).toHaveBeenCalledTimes(1)
  finish({ listeners: [], parents: new Map() })
  await first
  void scanner.get()
  expect(scan).toHaveBeenCalledTimes(2)
  finish({ listeners: [], parents: new Map() })
})
