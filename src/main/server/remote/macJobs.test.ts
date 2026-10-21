import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { MacBridgePush, MacBridgeRequest } from '@shared/contract-macbridge'
import {
  MAC_JOB_IDLE_MS,
  MAC_JOB_TOOL_DESCRIPTIONS,
  MAC_JOB_TOOL_PARAMS,
  type MacJobReadResult,
  type MacJobStartResult
} from '@shared/contract-macjobs'
import type { SessionMeta } from '@shared/events'
import { MacBridge } from './macBridge'
import {
  RollingOutput,
  continuationHead,
  incompleteTail,
  pipeSpawner,
  type JobProcess,
  type JobSpawner
} from './macJobs'
import { PeerCalls, handlePeerRequest, servePeerCall } from './peerCalls'
import { MacThreadTokens, MacTools, runJobTool } from '../macTools'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-macjobs-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => void vi.useRealTimers())

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── output, pure ─────────────────────────────────────────────────────

describe('RollingOutput', () => {
  it('keeps the newest cap bytes and their absolute offsets', () => {
    const out = new RollingOutput(10)
    out.push(Buffer.from('abcdef'))
    out.push(Buffer.from('ghijkl'))
    expect(out.total).toBe(12)
    expect(out.start).toBe(2)
    const all = out.read(0, 100, true)
    expect(all.data.toString()).toBe('cdefghijkl')
    expect(all).toMatchObject({ offset: 2, nextOffset: 12, skipped: 2 })
    expect(out.read(8, 100, true).data.toString()).toBe('ijkl')
    expect(out.read(12, 100, true)).toMatchObject({ offset: 12, nextOffset: 12, skipped: 0 })
    expect(out.read(99, 100, true).nextOffset).toBe(12)
  })
  it('a read answers the newest max bytes past the offset', () => {
    const out = new RollingOutput(100)
    out.push(Buffer.from('0123456789'))
    expect(out.read(0, 4, true)).toMatchObject({ offset: 6, nextOffset: 10, skipped: 6 })
    expect(out.read(0, 4, true).data.toString()).toBe('6789')
  })
  it('never cuts a character: a split tail waits, a split head is skipped', () => {
    const e = Buffer.from('é') // c3 a9
    expect(incompleteTail(Buffer.from([0x61, e[0]]))).toBe(1)
    expect(incompleteTail(Buffer.from('aé'))).toBe(0)
    expect(incompleteTail(Buffer.from('a'))).toBe(0)
    expect(incompleteTail(Buffer.from('😀').subarray(0, 3))).toBe(3)
    expect(continuationHead(Buffer.from('😀').subarray(1))).toBe(3)
    const out = new RollingOutput(100)
    out.push(Buffer.from([0x61, e[0]]))
    const first = out.read(0, 100, false)
    expect(first.data.toString()).toBe('a')
    out.push(Buffer.from([e[1], 0x62]))
    expect(out.read(first.nextOffset, 100, false).data.toString()).toBe('éb')
    const head = out.read(0, 2, true)
    expect(head.data.toString()).toBe('b')
    expect(head.skipped).toBe(3)
  })
})

// ── a fake process, for limits and timers ────────────────────────────

class FakeProc implements JobProcess {
  pid = undefined
  pty = false
  written: string[] = []
  stdinClosed = false
  signals: string[] = []
  private data: ((c: Buffer) => void)[] = []
  private exits: ((code: number | null, signal: string | null) => void)[] = []
  private done = false
  write(b: Buffer): void {
    this.written.push(b.toString())
    this.emit(b.toString())
  }
  closeStdin(): void {
    this.stdinClosed = true
  }
  onData(cb: (c: Buffer) => void): void {
    this.data.push(cb)
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exits.push(cb)
  }
  kill(sig: NodeJS.Signals): void {
    this.signals.push(sig)
    if (sig !== 'SIGINT') this.exit(null, sig)
  }
  emit(s: string): void {
    for (const cb of this.data) cb(Buffer.from(s))
  }
  exit(code: number | null, signal: string | null): void {
    if (this.done) return
    this.done = true
    for (const cb of this.exits) cb(code, signal)
  }
}

// ── the Mac side, called as a box would ──────────────────────────────

function mac(spawner?: JobSpawner, opts: { policy?: 'read' | 'read+run' } = {}) {
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
    },
    managedRoots: () => [],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => null,
    home: root,
    shell: '/bin/sh',
    log: (l) => lines.push(l),
    ...(spawner ? { jobSpawner: spawner } : {})
  })
  mb.setPolicy('env_box', opts.policy ?? 'read+run')
  mb.subscribe((p) => pushes.push(p))
  const requests = (): MacBridgeRequest[] =>
    pushes
      .filter(
        (p): p is Extract<MacBridgePush, { push: 'macBridge.request' }> =>
          p.push === 'macBridge.request'
      )
      .map((p) => p.request)
  const call = <T>(method: string, args: unknown, thread = 's1'): Promise<T> =>
    mb.handle(
      method as Parameters<MacBridge['handle']>[0],
      { thread: { id: thread, title: `T ${thread}` }, args } as never,
      { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    ) as Promise<T>
  /** Start a job and allow it on the card (remember: the exact command, for this thread). */
  const start = async (
    args: Record<string, unknown>,
    thread = 's1',
    remember = false
  ): Promise<MacJobStartResult> => {
    const before = requests().length
    const p = call<MacJobStartResult>('mac.jobStart', args, thread)
    for (let i = 0; i < 200 && requests().length === before; i++) await Promise.resolve()
    const req = requests()[before]
    if (req?.status === 'pending') mb.decide(req.id, true, remember)
    return p
  }
  return { mb, call, start, requests, pushes, lines }
}

const readUntil = async (
  call: ReturnType<typeof mac>['call'],
  jobId: string,
  done: (r: MacJobReadResult, text: string) => boolean,
  thread = 's1'
): Promise<{ last: MacJobReadResult; text: string }> => {
  let text = ''
  let offset = 0
  for (let i = 0; i < 200; i++) {
    const r = await call<MacJobReadResult>(
      'mac.jobRead',
      { jobId, afterOffset: offset, waitMs: 200 },
      thread
    )
    text += r.output
    offset = r.nextOffset
    if (done(r, text)) return { last: r, text }
  }
  throw new Error(`job never got there: ${JSON.stringify(text)}`)
}
const b64 = (s: string): string => Buffer.from(s).toString('base64')

describe('a job, piped (cat)', () => {
  it('start, write two lines, read them, close stdin, exit 0; the card goes running then done', async () => {
    const m = mac(pipeSpawner)
    const { jobId, pty } = await m.start({ argv: ['cat'], cwd: root })
    expect(pty).toBe(false)
    const card = m.requests()[0]
    expect(card).toMatchObject({
      kind: 'run',
      method: 'mac.run',
      argv: ['cat'],
      cwd: root,
      interactive: true
    })
    expect(m.requests().at(-1)?.status).toBe('running')
    await m.call('mac.jobWrite', { jobId, dataBase64: b64('one\n') })
    await m.call('mac.jobWrite', { jobId, dataBase64: b64('two\n') })
    const mid = await readUntil(m.call, jobId, (_r, t) => t === 'one\ntwo\n')
    expect(mid.last).toMatchObject({ running: true, stdinOpen: true, exitCode: null })
    await m.call('mac.jobClose', { jobId })
    await expect(m.call('mac.jobWrite', { jobId, dataBase64: b64('x') })).rejects.toThrow(
      /stdin is closed/
    )
    const end = await readUntil(m.call, jobId, (r) => !r.running)
    expect(end.last).toMatchObject({ running: false, exitCode: 0, signal: null, stdinOpen: false })
    expect(end.last.ended).toBeUndefined()
    // A read from the start still has everything.
    const all = await m.call<MacJobReadResult>('mac.jobRead', { jobId })
    expect(all.output).toBe('one\ntwo\n')
    expect(
      m.pushes.some(
        (p) => p.push === 'macBridge.resolved' && p.id === card.id && p.outcome === 'done'
      )
    ).toBe(true)
    expect(
      m.lines.some((l) => l.includes('mac.jobStart') && l.includes('allowed (asked) argv0=cat'))
    ).toBe(true)
    expect(m.lines.some((l) => l.includes(`job ${jobId} ran: exit 0`))).toBe(true)
    // Nothing a job wrote reaches the log.
    expect(m.lines.join('\n')).not.toMatch(/one|two/)
  })

  it('signal INT reaches the process; another thread cannot touch the job', async () => {
    const m = mac(pipeSpawner)
    const { jobId } = await m.start({ argv: ['sleep', '30'], cwd: root })
    await expect(m.call('mac.jobRead', { jobId }, 's2')).rejects.toThrow(
      /no such job for this thread/
    )
    await expect(m.call('mac.jobSignal', { jobId, signal: 'KILL' }, 's2')).rejects.toThrow(
      /no such job/
    )
    const sig = await m.call<{ running: boolean }>('mac.jobSignal', { jobId, signal: 'INT' })
    expect(sig.running).toBe(true)
    const end = await readUntil(m.call, jobId, (r) => !r.running)
    expect(end.last).toMatchObject({ running: false, exitCode: null, signal: 'SIGINT' })
  })

  it('a denied job never starts; policy read refuses before asking', async () => {
    const m = mac(pipeSpawner)
    const p = m.call('mac.jobStart', { argv: ['cat'] })
    for (let i = 0; i < 50 && !m.requests().length; i++) await Promise.resolve()
    m.mb.decide(m.requests()[0].id, false)
    await expect(p).rejects.toThrow(/denied at the Mac/)
    expect(m.mb.jobs.runningCount()).toBe(0)
    const r = mac(pipeSpawner, { policy: 'read' })
    await expect(r.call('mac.jobStart', { argv: ['cat'] })).rejects.toThrow(/not run commands/)
    expect(r.requests()).toHaveLength(0)
  })
})

let ptyLoads = false
try {
  await import('node-pty')
  ptyLoads = true
} catch {
  ptyLoads = false
}

describe.runIf(ptyLoads)('a job in a terminal (node-pty)', () => {
  it('cat echoes, answers, and ends on close (^D) with exit 0', async () => {
    const m = mac() // the default spawner: node-pty
    const { jobId, pty } = await m.start({ argv: ['cat'], cwd: root })
    expect(pty).toBe(true)
    await m.call('mac.jobWrite', { jobId, dataBase64: b64('first line\n') })
    await m.call('mac.jobWrite', { jobId, dataBase64: b64('second line\n') })
    await readUntil(m.call, jobId, (_r, t) => (t.match(/second line/g) ?? []).length >= 2)
    await m.call('mac.jobClose', { jobId })
    const end = await readUntil(m.call, jobId, (r) => !r.running)
    expect(end.last).toMatchObject({ running: false, exitCode: 0 })
  })
})

describe('limits and timers', () => {
  it('at most 4 running per thread, refused without a prompt; another thread has its own 4', async () => {
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await m.start({ argv: ['cat', String(i)] })).jobId)
    const asked = m.requests().length
    await expect(m.call('mac.jobStart', { argv: ['cat', 'x'] })).rejects.toThrow(
      /already has 4 jobs/
    )
    expect(m.requests().length).toBe(asked)
    await m.start({ argv: ['cat'] }, 's2')
    procs[0].exit(0, null)
    // One ended: room for one more.
    await m.start({ argv: ['cat', 'again'] })
    expect(m.mb.jobs.runningCount('env_box', 's1')).toBe(4)
  })

  it('remembered for this thread: the next same start shows as running at once, no prompt', async () => {
    const m = mac(() => new FakeProc())
    await m.start({ argv: ['ssh', 'host'], cwd: root }, 's1', true)
    const before = m.requests().length
    await m.call('mac.jobStart', { argv: ['ssh', 'host'], cwd: root })
    const shown = m.requests().slice(before)
    expect(shown.map((r) => r.status)).toEqual(['pending', 'running'])
    // Another thread, or another cwd, asks again.
    const p = m.call('mac.jobStart', { argv: ['ssh', 'host'], cwd: root }, 's2')
    for (let i = 0; i < 50 && m.requests().length === before + 2; i++) await Promise.resolve()
    expect(m.requests().at(-1)?.status).toBe('pending')
    m.mb.decide(m.requests().at(-1)!.id, false)
    await expect(p).rejects.toThrow(/denied/)
  })

  it('a full-access thread starts a job with no prompt; the card shows it running', async () => {
    const m = mac(() => new FakeProc())
    const before = m.requests().length
    const started = await m.mb.handle(
      'mac.jobStart',
      { thread: { id: 's7', title: 'auto', permission: 'auto' }, args: { argv: ['ssh', 'host'], cwd: root } } as never,
      { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    )
    expect(started).toBeTruthy()
    expect(m.requests().slice(before).map((r) => r.status)).toEqual(['pending', 'running'])
  })

  it('30 idle minutes with no call end the job; 30 more forget it; a read restarts the clock', async () => {
    vi.useFakeTimers()
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const { jobId } = await m.start({ argv: ['cat'] })
    await vi.advanceTimersByTimeAsync(MAC_JOB_IDLE_MS - 60_000)
    await m.call('mac.jobRead', { jobId })
    await vi.advanceTimersByTimeAsync(MAC_JOB_IDLE_MS - 60_000)
    expect(procs[0].signals).toEqual([])
    await vi.advanceTimersByTimeAsync(60_001)
    expect(procs[0].signals).toEqual(['SIGTERM'])
    const ended = await m.call<MacJobReadResult>('mac.jobRead', { jobId })
    expect(ended).toMatchObject({ running: false, ended: 'idle' })
    await vi.advanceTimersByTimeAsync(MAC_JOB_IDLE_MS + 1)
    await expect(m.call('mac.jobRead', { jobId })).rejects.toThrow(/no such job/)
    expect(m.lines.some((l) => l.includes('idle for 30 min'))).toBe(true)
  })

  it('a read with waitMs wakes on output', async () => {
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const { jobId } = await m.start({ argv: ['cat'] })
    const t0 = Date.now()
    const r = m.call<MacJobReadResult>('mac.jobRead', { jobId, waitMs: 10_000 })
    setTimeout(() => procs[0].emit('hello'), 30)
    expect((await r).output).toBe('hello')
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('the thread ending, the policy dropping and the app closing end jobs', async () => {
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const a = await m.start({ argv: ['cat'] })
    await m.start({ argv: ['cat'] }, 's2')
    const res = await m.call<{ ended: number }>('mac.jobsEnd', {})
    expect(res.ended).toBe(1)
    expect(procs[0].signals).toEqual(['SIGTERM'])
    await expect(m.call('mac.jobRead', { jobId: a.jobId })).rejects.toThrow(/no such job/)
    expect(m.mb.jobs.runningCount('env_box', 's2')).toBe(1)
    m.mb.setPolicy('env_box', 'read')
    expect(procs[1].signals).toEqual(['SIGTERM'])
    m.mb.setPolicy('env_box', 'read+run')
    await m.start({ argv: ['cat'] })
    m.mb.close()
    expect(procs[2].signals[0]).toBe('SIGTERM')
    expect(m.mb.jobs.runningCount()).toBe(0)
  })

  it('Stop on the card ends the job', async () => {
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const { jobId } = await m.start({ argv: ['cat'] })
    const running = m.requests().at(-1)!
    expect(running.status).toBe('running')
    m.mb.decide(running.id, false)
    const r = await m.call<MacJobReadResult>('mac.jobRead', { jobId })
    expect(r).toMatchObject({ running: false, ended: 'stopped' })
    expect(
      m.pushes.some(
        (p) => p.push === 'macBridge.resolved' && p.id === running.id && p.outcome === 'stopped'
      )
    ).toBe(true)
  })
})

// ── the box side: token, routing, a thread's end ─────────────────────

describe('the box: MacTools job calls over the peer link', () => {
  const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
    ({
      id,
      parentId: null,
      projectId: null,
      workspaceId: null,
      title: `T ${id}`,
      status: 'idle',
      permission: 'safe',
      ...extra
    }) as SessionMeta

  function box() {
    const procs: FakeProc[] = []
    const m = mac(() => {
      const p = new FakeProc()
      procs.push(p)
      return p
    })
    const calls = new PeerCalls('env_box', () => {})
    const sessions = new Map<string, SessionMeta>([
      ['t1', meta('t1')],
      ['sub', meta('sub', { parentId: 't1' })],
      ['t2', meta('t2')]
    ])
    const socket = {
      connection: 1,
      keyId: 'k',
      remote: true,
      send: (frame: ServerFrame) => {
        if (!('push' in frame) || frame.push !== 'peer.call') return
        void servePeerCall(
          frame as Extract<MacBridgePush, { push: 'peer.call' }>,
          'env_box',
          (method, params, ctx) =>
            m.mb.handle(method, params, { from: ctx.from, deadlineAt: ctx.deadlineAt }),
          async (method, params) =>
            handlePeerRequest(calls, socket, { method, params } as Parameters<
              typeof handlePeerRequest
            >[2])
        )
      }
    }
    handlePeerRequest(calls, socket, {
      method: 'peer.register',
      params: { from: 'env_mac', offers: ['mac-bridge'] }
    })
    const settings = new Map<string, string>()
    const tokens = new MacThreadTokens('ef'.repeat(16))
    const tools = new MacTools({
      store: {
        getSetting: (k) => settings.get(k) ?? null,
        setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
      },
      sessions: { get: (id) => sessions.get(id) ?? null },
      landing: { getProject: () => null, getWorkspace: () => null },
      dataDir: join(root, 'box-data'),
      calls,
      tokens,
      log: () => {}
    })
    tools.setThread('t1', 'env_mac')
    tools.setThread('t2', 'env_mac')
    /** mac.run background: true, as the thread's tool would, allowed on the Mac's card. */
    const startJob = async (sid: string): Promise<MacJobStartResult> => {
      const before = m.requests().length
      const p = tools.call(sid, tokens.tokenFor(sid), 'mac.run', {
        argv: ['cat'],
        background: true
      })
      for (let i = 0; i < 100 && m.requests().length === before; i++) await sleep(2)
      m.mb.decide(m.requests()[before].id, true)
      return (await p) as MacJobStartResult
    }
    return { m, procs, tools, tokens, startJob }
  }

  it('mac.run background: true starts a job; write, read, close and signal go by the thread token', async () => {
    const { m, procs, tools, tokens, startJob } = box()
    const { jobId } = await startJob('t1')
    expect(m.requests()[0]).toMatchObject({ interactive: true, argv: ['cat'], sessionId: 't1' })
    const t = tokens.tokenFor('t1')
    const handled = await tools.handle({
      id: 'x',
      method: 'mac.jobWrite',
      params: { sessionId: 't1', token: t, jobId, dataBase64: b64('hi\n') }
    })
    expect(handled).toEqual({ handled: true, result: { jobId, bytes: 3 } })
    const read = (await tools.callJob('t1', t, 'mac.jobRead', { jobId })) as MacJobReadResult
    expect(read.output).toBe('hi\n')
    await tools.callJob('t1', t, 'mac.jobClose', { jobId })
    expect(procs[0].stdinClosed).toBe(true)
    await tools.callJob('t1', t, 'mac.jobSignal', { jobId, signal: 'TERM' })
    expect(procs[0].signals).toEqual(['SIGTERM'])
  })

  it('the token gate: a wrong token or another thread’s is refused before the Mac hears; another thread’s job id is not found', async () => {
    const { m, tools, tokens, startJob } = box()
    const { jobId } = await startJob('t1')
    const asked = m.requests().length
    await expect(tools.callJob('t1', 'nope', 'mac.jobRead', { jobId })).rejects.toThrow(/own token/)
    await expect(
      tools.callJob('t1', tokens.tokenFor('t2'), 'mac.jobRead', { jobId })
    ).rejects.toThrow(/own token/)
    await expect(
      tools.call('t1', 'nope', 'mac.run', { argv: ['cat'], background: true })
    ).rejects.toThrow(/own token/)
    expect(m.requests().length).toBe(asked)
    await expect(
      tools.callJob('t2', tokens.tokenFor('t2'), 'mac.jobRead', { jobId })
    ).rejects.toThrow(/no such job for this thread/)
  })

  it('a thread that ends on the box ends its jobs on the Mac (and a subagent’s with its parent)', async () => {
    const { m, procs, tools, startJob } = box()
    await startJob('t1')
    await startJob('sub')
    await startJob('t2')
    tools.threadsEnded(['t1'])
    for (let i = 0; i < 100 && procs[1].signals.length === 0; i++) await sleep(2)
    expect(procs[0].signals).toEqual(['SIGTERM'])
    expect(procs[1].signals).toEqual(['SIGTERM'])
    expect(procs[2].signals).toEqual([])
    expect(m.mb.jobs.runningCount()).toBe(1)
  })

  it('the job tools map text, base64 and close onto the methods', async () => {
    const seen: [string, unknown][] = []
    const call = async (method: string, args: unknown) => {
      seen.push([method, args])
      return method === 'mac.jobWrite' ? { bytes: 1 } : { stdinOpen: false }
    }
    expect(
      await runJobTool('mac_job_write', { jobId: 'j', text: 'é\n', close: true }, call)
    ).toEqual({
      jobId: 'j',
      bytes: 1,
      stdinOpen: false
    })
    expect(seen).toEqual([
      ['mac.jobWrite', { jobId: 'j', dataBase64: b64('é\n') }],
      ['mac.jobClose', { jobId: 'j' }]
    ])
    await expect(runJobTool('mac_job_write', { jobId: 'j' }, call)).rejects.toThrow(/needs text/)
    await expect(
      runJobTool('mac_job_write', { jobId: 'j', text: 'a', dataBase64: 'YQ==' }, call)
    ).rejects.toThrow(/not both/)
  })
})

describe('the codex bridge keeps the job tools equal', async () => {
  const bridge = (await import(
    join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')
  )) as {
    MAC_JOB_TOOLS: {
      name: string
      description: string
      inputSchema: { properties: Record<string, { description?: string }> }
    }[]
    MAC_TOOLS: {
      name: string
      inputSchema: { properties: Record<string, { description?: string }> }
    }[]
    runJobTool: typeof runJobTool
  }
  it('same descriptions and params as contract-macjobs.ts, and mac_run carries background', async () => {
    expect(bridge.MAC_JOB_TOOLS.map((t) => t.name)).toEqual(Object.keys(MAC_JOB_TOOL_DESCRIPTIONS))
    for (const t of bridge.MAC_JOB_TOOLS) {
      expect(t.description).toBe(
        MAC_JOB_TOOL_DESCRIPTIONS[t.name as keyof typeof MAC_JOB_TOOL_DESCRIPTIONS]
      )
      for (const [k, v] of Object.entries(t.inputSchema.properties))
        expect(v.description).toBe(MAC_JOB_TOOL_PARAMS[k as keyof typeof MAC_JOB_TOOL_PARAMS])
    }
    const run = bridge.MAC_TOOLS.find((t) => t.name === 'mac_run')
    expect(run?.inputSchema.properties.background?.description).toBe(MAC_JOB_TOOL_PARAMS.background)
    const seen: string[] = []
    await bridge.runJobTool(
      'mac_job_write',
      { jobId: 'j', text: 'x', close: true },
      async (m: string) => {
        seen.push(m)
        return {}
      }
    )
    expect(seen).toEqual(['mac.jobWrite', 'mac.jobClose'])
  })
})
