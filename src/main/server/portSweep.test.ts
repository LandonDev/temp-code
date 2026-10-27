import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventRow, SessionMeta } from '@shared/events'
import { openDb } from './db'
import { attribute, outputPaths, parseEnviron, PortSweep, serverCommand, skipReason, type AttributeContext, type ProcInfo, type SweepThread } from './portSweep'
import { ThreadResources } from './threadResources'
import { SharedScanner, type Scan } from './threadPorts'
import { parseEtime, parseStarts, type Listener } from './threadPortsParse'

const ME = 'env_box000000000000000000'
const T0 = 1_000_000_000

const proc = (pid: number, over: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid: null,
  startedAt: T0 + 60_000,
  cwd: null,
  args: null,
  threadId: null,
  claudePid: null,
  files: [],
  ...over
})
const thread = (id: string, over: Partial<SweepThread> = {}): SweepThread => ({
  id,
  cwd: `/srv/agents/work/${id}`,
  harnessPid: null,
  harnessStartedAt: null,
  live: true,
  createdAt: T0,
  activeAt: T0,
  ...over
})
const listener = (port: number, pid: number, command: string | null = 'node'): Listener => ({ port, pid, address: '*', command })
const ctx = (threads: SweepThread[], files: Record<string, { sessionId: string; callId: string }> = {}): AttributeContext => ({
  threads,
  fileOwner: (p) => files[p] ?? null,
  ownPid: 7,
  home: '/srv/agents/home'
})

describe('skipReason', () => {
  it('skips system ports, databases, infrastructure and the app itself', () => {
    expect(skipReason(listener(80, 10), [], 7)).toBe('a system port')
    expect(skipReason(listener(5432, 10), [], 7)).toBe('a database or debugger port')
    expect(skipReason(listener(6379, 10, 'redis-server'), [], 7)).toBe('a database or debugger port')
    expect(skipReason(listener(4040, 10, 'ngrok'), [], 7)).toBe('infrastructure (ngrok)')
    expect(skipReason(listener(8080, 10, 'docker-proxy'), [], 7)).toBe('infrastructure (docker-proxy)')
    expect(skipReason(listener(20241, 10, 'cloudflared'), [], 7)).toBe('infrastructure (cloudflared)')
    expect(skipReason(listener(46525, 7, 'electron'), [], 7)).toBe("the app's own")
    expect(skipReason(listener(38591, 8, 'electron'), [], 7)).toBe('infrastructure (electron)')
    expect(skipReason(listener(3001, 10, 'next-server (v1'), [], 7)).toBeNull()
  })

  it('skips MCP servers, proxies and debuggers by name, command or port', () => {
    const args = (a: string) => [proc(10, { args: a })]
    expect(skipReason(listener(9229, 10), [], 7)).toBe('a database or debugger port')
    expect(skipReason(listener(8443, 10, 'nginx'), [], 7)).toBe('infrastructure (nginx)')
    expect(skipReason(listener(8081, 10, 'caddy'), [], 7)).toBe('infrastructure (caddy)')
    expect(skipReason(listener(3333, 10), args('node /usr/lib/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'), 7)).toBe('an MCP server, proxy or debugger')
    expect(skipReason(listener(3334, 10), args('npx -y chrome-devtools-mcp@latest --port 3334'), 7)).toBe('an MCP server, proxy or debugger')
    expect(skipReason(listener(3335, 10), args('node dist/mcp-server.js'), 7)).toBe('an MCP server, proxy or debugger')
    expect(skipReason(listener(4000, 10), args('node --inspect server.js'), 7)).toBeNull()
    // A project folder with mcp in its name still serves real dev servers.
    expect(skipReason(listener(5173, 10), args('node /srv/agents/work/temp-code-mcp/node_modules/.bin/vite'), 7)).toBeNull()
    expect(skipReason(listener(3000, 10), args('python3 -m http.server 3000'), 7)).toBeNull()
  })

  it('skips a test run, a typecheck and the gate, by any process above the listener', () => {
    const chain = (...a: string[]) => a.map((x, i) => proc(10 + i, { args: x }))
    const gate = 'a test run or the gate'
    expect(skipReason(listener(44575, 10), chain('node /srv/x/node_modules/vitest/dist/workers/forks.js', '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since ee6c899'), 7)).toBe(gate)
    expect(skipReason(listener(40879, 10), chain('node worker.js', 'NODE_ENV=test bunx vitest run src/a.test.ts'), 7)).toBe(gate)
    expect(skipReason(listener(37631, 10), chain('bun test'), 7)).toBe(gate)
    expect(skipReason(listener(46449, 10), chain('node (vitest 11)'), 7)).toBe(gate)
    expect(skipReason(listener(43401, 10), chain('npm run typecheck'), 7)).toBe(gate)
    expect(skipReason(listener(5173, 10), chain('node node_modules/.bin/vite', 'bun run dev'), 7)).toBeNull()
    expect(skipReason(listener(5174, 10), chain('cd apps/vitest-demo && bun run dev'), 7)).toBeNull()
    // The merge gate's vitest worker, as the box saw it filed: the worker's own command names tinypool, the gate is two above.
    expect(skipReason(listener(45649, 10), chain('node /srv/agents/work/temp-code/node_modules/tinypool/dist/entry/process.js', 'node /srv/agents/work/temp-code/node_modules/vitest/dist/cli.js', '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since 00bb5d7c288…'), 7)).toBe(gate)
  })
})

describe('attribute', () => {
  it('credits a process still under a harness (ancestry)', () => {
    const t = thread('a', { harnessPid: 100, harnessStartedAt: T0 })
    const v = attribute(listener(5173, 300), [proc(300), proc(200, { claudePid: 100 }), proc(100)], ctx([t]))
    expect(v).toEqual({ credit: { sessionId: 'a', callId: null, by: 'ancestry' } })
  })

  it('skips what the harness started with itself (an MCP server) and the harness itself', () => {
    const t = thread('a', { harnessPid: 100, harnessStartedAt: T0 })
    expect(attribute(listener(9999, 150), [proc(150, { startedAt: T0 + 2_000 }), proc(100)], ctx([t]))).toEqual({ skip: 'started with the harness (an MCP server)', final: true })
    expect(attribute(listener(9999, 100), [proc(100)], ctx([t]))).toEqual({ skip: 'the harness itself', final: true })
    // A tool call's child says so in its environment, however early.
    expect(attribute(listener(5173, 150), [proc(150, { startedAt: T0 + 2_000, claudePid: 100 }), proc(100)], ctx([t]))).toMatchObject({ credit: { sessionId: 'a', by: 'ancestry' } })
  })

  it('credits a reparented process by the thread id, else the harness pid, in its environment', () => {
    const a = thread('a', { harnessPid: 100 })
    const b = thread('b', { harnessPid: 200 })
    expect(attribute(listener(8081, 300), [proc(300, { threadId: 'b', claudePid: 100 })], ctx([a, b]))).toMatchObject({ credit: { sessionId: 'b', by: 'environment' } })
    expect(attribute(listener(8081, 300), [proc(300, { threadId: 'gone', claudePid: 100 })], ctx([a, b]))).toMatchObject({ credit: { sessionId: 'a', by: 'environment' } })
  })

  it('credits by the output file a shell call named, a deleted one too', () => {
    const files = { '/tmp/claude-999/x/tasks/abc.output': { sessionId: 'b', callId: 'c9' } }
    const chain = [proc(300, { files: ['/tmp/ncr.log'] }), proc(299, { files: ['/tmp/claude-999/x/tasks/abc.output (deleted)'] })]
    expect(attribute(listener(8081, 300), chain, ctx([thread('a'), thread('b')], files))).toEqual({ credit: { sessionId: 'b', callId: 'c9', by: 'output-file' } })
  })

  it('credits by working directory: deepest folder, then live, then most recently active', () => {
    const project = thread('p', { cwd: '/srv/agents/work/app', activeAt: T0 + 50_000 })
    const worktree = thread('w', { cwd: '/srv/agents/work/app/.claude/worktrees/x', live: false, activeAt: T0 + 90_000 })
    const idle = thread('i', { cwd: '/srv/agents/work/app', live: false, activeAt: T0 + 70_000 })
    const inWorktree = [proc(300, { cwd: '/srv/agents/work/app/.claude/worktrees/x/web' })]
    expect(attribute(listener(3000, 300), inWorktree, ctx([project, worktree, idle]))).toMatchObject({ credit: { sessionId: 'w', by: 'cwd' } })
    const inProject = [proc(300, { cwd: '/srv/agents/work/app/apps/web' })]
    expect(attribute(listener(3000, 300), inProject, ctx([idle, project]))).toMatchObject({ credit: { sessionId: 'p', by: 'cwd' } })
    const second = thread('q', { cwd: '/srv/agents/work/app', activeAt: T0 + 55_000 })
    expect(attribute(listener(3000, 300), inProject, ctx([project, second]))).toMatchObject({ credit: { sessionId: 'q' } })
  })

  it('never credits by folder a port bound before a thread worked there, nor a thread whose cwd is home', () => {
    const late = thread('a', { cwd: '/srv/agents/work/app', createdAt: T0 + 120_000 })
    const chain = [proc(300, { cwd: '/srv/agents/work/app', startedAt: T0 + 60_000 })]
    expect(attribute(listener(3000, 300), chain, ctx([late]))).toEqual({ skip: 'bound before a thread worked in /srv/agents/work/app', final: true })
    // A thread that went quiet before the server started, its harness gone, is not its owner either.
    const quiet = thread('b', { cwd: '/srv/agents/work/app', live: false, activeAt: T0 + 10_000 })
    expect(attribute(listener(3000, 300), chain, ctx([quiet]))).toMatchObject({ skip: expect.stringMatching(/^bound before/) })
    const home = thread('h', { cwd: '/srv/agents/home' })
    expect(attribute(listener(3000, 300), [proc(300, { cwd: '/srv/agents/home/proj' })], ctx([home]))).toEqual({ skip: 'no thread', final: false })
  })

  it('reads the folder from an ancestor when the listener has none', () => {
    const chain = [proc(300), proc(299, { cwd: '/srv/agents/work/a/web' })]
    expect(attribute(listener(3000, 300), chain, ctx([thread('a')]))).toMatchObject({ credit: { sessionId: 'a', by: 'cwd' } })
  })
})

describe('the parsers', () => {
  it('parseEnviron reads the thread scope and CLAUDE_PID', () => {
    const env = ['PATH=/bin', 'ANTHROPIC_BASE_URL=http://127.0.0.1:46525/claude/~t=kqKsKGuY3l7v;a=me%40x.com;m=claude-opus-5-5', 'CLAUDE_PID=3967302', ''].join('\0')
    expect(parseEnviron(env)).toEqual({ threadId: 'kqKsKGuY3l7v', claudePid: 3967302 })
    expect(parseEnviron('ANTHROPIC_BASE_URL=http://127.0.0.1:1/claude/~w=warm1\0')).toEqual({ threadId: null, claudePid: null })
  })

  it('outputPaths finds the background task file and absolute redirect targets', () => {
    expect(outputPaths('cd apps/web && nohup bun run dev > /tmp/web.log 2>&1 &')).toEqual(['/tmp/web.log'])
    expect(outputPaths('npx expo start &>/tmp/expo.log & echo started; cat x 2>/dev/null')).toEqual(['/tmp/expo.log'])
    expect(outputPaths('Command running in background with ID: bmvurtt73. Output is being written to: /tmp/claude-999/-srv-x/abc/tasks/bmvurtt73.output')).toEqual([
      '/tmp/claude-999/-srv-x/abc/tasks/bmvurtt73.output'
    ])
    expect(outputPaths('bun run dev > web.log &')).toEqual([])
  })

  it('parseEtime and parseStarts read ps start times', () => {
    expect(parseEtime('06:17')).toBe(377_000)
    expect(parseEtime('1:02:03')).toBe(3_723_000)
    expect(parseEtime('2-00:00:01')).toBe(172_801_000)
    expect(parseEtime('bad')).toBeNull()
    expect(parseStarts('  10     1    00:05\n  11 10 bad\n', 100_000)).toEqual(new Map([[10, 95_000]]))
  })

  it('serverCommand names the topmost process of the server, past shells and stops', () => {
    const chain = [proc(3, { args: 'next-server (v16.3.6)' }), proc(2, { args: 'node /w/node_modules/.bin/next dev --port 3001' }), proc(1, { args: 'bun run dev' }), proc(0, { args: '/bin/bash -c source snap' })]
    expect(serverCommand(chain, new Set())).toBe('bun run dev')
    expect(serverCommand(chain, new Set([1]))).toBe('node /w/node_modules/.bin/next dev --port 3001')
  })
})

describe('PortSweep', () => {
  let db: ReturnType<typeof openDb>
  let ledger: ThreadResources
  let listeners: Listener[]
  let parents: Map<number, number>
  let started: Map<number, number>
  let procs: Map<number, Partial<ProcInfo>>
  let probes: number[]
  let threads: Omit<SweepThread, 'harnessStartedAt'>[]
  let claimed: Set<number>
  let sweep: PortSweep
  let recorded: number

  beforeEach(() => {
    db = openDb(':memory:')
    const sessions = new Map<string, SessionMeta>([['a', { id: 'a', parentId: null } as SessionMeta]])
    ledger = new ThreadResources({ db, environmentId: ME, sessions: { get: (id) => sessions.get(id) ?? null }, runOn: async () => ({ exitCode: 0, stdout: '', stderr: '' }), now: () => T0, log: () => {} })
    listeners = [listener(46525, 7, 'electron'), listener(5432, 50, 'postgres')]
    parents = new Map([[7, 1], [50, 1]])
    started = new Map()
    procs = new Map()
    probes = []
    threads = [{ id: 'a', cwd: '/srv/agents/work/a', harnessPid: null, live: true, createdAt: T0, activeAt: T0 }]
    claimed = new Set()
    recorded = 0
    let now = T0 + 100_000
    sweep = new PortSweep({
      resources: ledger,
      environmentId: ME,
      scanner: new SharedScanner(async (): Promise<Scan> => ({ listeners: [...listeners], parents: new Map(parents), started: new Map(started) }), () => (now += 10_000)),
      threads: () => threads,
      anyLive: () => true,
      claimed: (port) => claimed.has(port),
      recorded: () => recorded++,
      ownPid: 7,
      home: '/srv/agents/home',
      probe: async (pid) => {
        probes.push(pid)
        return { cwd: null, args: null, threadId: null, claudePid: null, files: [], ...procs.get(pid) }
      },
      now: () => now,
      log: () => {}
    })
  })
  afterEach(() => {
    sweep.close()
    db.close()
  })

  const serve = (port: number, pid: number, info: Partial<ProcInfo>, parent = 1) => {
    listeners.push(listener(port, pid, 'node'))
    parents.set(pid, parent)
    started.set(pid, T0 + 60_000)
    procs.set(pid, info)
  }
  const event = (e: object, sessionId = 'a'): EventRow => ({ sessionId, seq: 1, ts: T0 + 30_000, event: e }) as unknown as EventRow

  it('records a reparented server in a thread folder, labelled by its process, and looks at it once', async () => {
    serve(3001, 300, { cwd: '/srv/agents/work/a/apps/web', args: 'bun run dev' })
    const first = await sweep.sweep()
    expect(first.find((r) => r.port === 3001)?.verdict).toEqual({ credit: { sessionId: 'a', callId: null, by: 'cwd' } })
    expect(ledger.live(ME, 'port', '3001')).toMatchObject({ sessionId: 'a', pid: 300, label: 'bun run dev' })
    expect(recorded).toBe(1)
    // Infrastructure never costs a probe; nothing new costs nothing at all.
    expect(probes).toEqual([300])
    expect(await sweep.sweep()).toEqual([])
    expect(probes).toEqual([300])
  })

  it('names the row from the process that listens', async () => {
    serve(3002, 302, { cwd: '/srv/agents/work/a', args: 'bun src/server.ts' })
    await sweep.sweep()
    expect(ledger.live(ME, 'port', '3002')).toMatchObject({ sessionId: 'a', what: 'Bun server' })
  })

  it('ties a server to the call that named its output file, and that file to the call', async () => {
    sweep.observeEvent(event({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'npx expo start --tunnel', run_in_background: true } }))
    sweep.observeEvent(event({ type: 'tool-result', callId: 'c1', output: 'Command running in background with ID: b1. Output is being written to: /tmp/cc/tasks/b1.output', isError: false }))
    serve(8081, 300, { cwd: '/elsewhere', files: ['/tmp/cc/tasks/b1.output (deleted)'] })
    await sweep.sweep()
    expect(ledger.live(ME, 'port', '8081')).toMatchObject({ sessionId: 'a', callId: 'c1', label: 'npx expo start --tunnel' })
    expect(sweep.fileOfCall('c1')).toBe('/tmp/cc/tasks/b1.output')
    expect(sweep.fileOfTask('b1')).toBe('/tmp/cc/tasks/b1.output')
    expect(sweep.fileOfTask('b2')).toBeNull()
  })

  it('guesses the call by the port it names when the rule gives none', async () => {
    sweep.observeEvent(event({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'cd apps/web && bun run dev -p 3002 &' } }))
    sweep.observeEvent(event({ type: 'tool-call', callId: 'c2', name: 'Bash', input: { command: 'ls' } }))
    serve(3002, 300, { cwd: '/srv/agents/work/a/apps/web', args: 'next-server (v16)' })
    await sweep.sweep()
    expect(ledger.live(ME, 'port', '3002')).toMatchObject({ callId: 'c1', label: 'cd apps/web && bun run dev -p 3002 &' })
  })

  it("the merge gate's vitest workers, under the app itself, are never filed, whatever their folder", async () => {
    // worker (300) <- vitest (250) <- the gate (240) <- the app (7): the gate runs in the project checkout, a thread's folder.
    procs.set(240, { cwd: '/srv/agents/work/a', args: '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since 00bb5d7c288…' })
    parents.set(240, 7)
    procs.set(250, { cwd: '/srv/agents/work/a', args: 'node /srv/agents/work/temp-code/node_modules/vitest/dist/cli.js run' })
    parents.set(250, 240)
    serve(45649, 300, { cwd: '/srv/agents/work/a', args: 'node /srv/agents/work/temp-code/node_modules/tinypool/dist/entry/process.js' }, 250)
    serve(45485, 301, { cwd: '/srv/agents/work/a', args: 'node /srv/agents/work/temp-code/node_modules/tinypool/dist/entry/process.js' }, 250)
    const reports = await sweep.sweep()
    expect(reports.filter((r) => r.port === 45649 || r.port === 45485).map((r) => r.verdict)).toEqual([
      { skip: 'a test run or the gate', final: true },
      { skip: 'a test run or the gate', final: true }
    ])
    expect(ledger.listAll({ kind: 'port' })).toEqual([])
    expect(recorded).toBe(0)
  })

  it('leaves Dev Server runs and rows already on the ledger alone, and a dry run records nothing', async () => {
    serve(5173, 300, { cwd: '/srv/agents/work/a' })
    serve(4000, 301, { cwd: '/srv/agents/work/a' })
    claimed.add(5173)
    const dry = await sweep.sweep({ dryRun: true })
    expect(dry.find((r) => r.port === 5173)?.verdict).toEqual({ skip: 'a Dev Server run', final: true })
    expect(dry.find((r) => r.port === 4000)?.verdict).toMatchObject({ credit: { sessionId: 'a' } })
    expect(dry.find((r) => r.port === 5432)?.verdict).toEqual({ skip: 'a database or debugger port', final: true })
    expect(ledger.live(ME, 'port', '4000')).toBeNull()
    await sweep.sweep()
    expect(ledger.live(ME, 'port', '5173')).toBeNull()
    expect(ledger.live(ME, 'port', '4000')).not.toBeNull()
    const again = await sweep.sweep({ dryRun: true })
    expect(again.find((r) => r.port === 4000)?.verdict).toEqual({ skip: 'on the ledger', final: true })
  })
})
