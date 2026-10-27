import { describe, expect, it } from 'vitest'
import type { AgentEvent, EventRow } from '@shared/events'
import {
  CAP_LINE_PREFIX,
  DEFAULT_CALL_CAP_BYTES,
  KILL_GRACE_MS,
  ORPHAN_GRACE_MS,
  ProcessGuard,
  environFromPsE,
  markersOf,
  parseGuardPs,
  unwrapBashCommand,
  wrapBashCommand,
  type GuardProc
} from './processGuard'

/**
 * The process guard over fake process trees: the orphan sweep, a call's
 * processes ending with the call, the memory cap, and the marks.
 */

/** The exact shape of the 2026-10-27 incident: a tinypool worker of a killed vitest, reparented to init, 2.8 GB each. */
const TINYPOOL = 'node --conditions node --conditions development /srv/agents/work/temp-code/.claude/worktrees/a5-slice3-build/node_modules/tinypool/dist/entry/process.js'
const GiB = 1024 * 1024 * 1024

const env = (pairs: Record<string, string>): string => `${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\0')}\0`
const MARKED = env({ PATH: '/usr/bin', TEMP_CODE_THREAD: 't1', TEMP_CODE_CALL: 'c1' })
const marked = (threadId: string, callId: string): string => env({ PATH: '/usr/bin', TEMP_CODE_THREAD: threadId, TEMP_CODE_CALL: callId })
const proc = (pid: number, ppid: number, pgid: number, args = 'bun test', rssKb = 50_000): GuardProc => ({ pid, ppid, pgid, rssKb, args })
const row = (sessionId: string, event: AgentEvent): EventRow => ({ sessionId, seq: 1, ts: 0, event })
const bashCall = (sessionId: string, callId: string, input: Record<string, unknown>): EventRow => row(sessionId, { type: 'tool-call', callId, name: 'Bash', input })

interface World {
  rows: GuardProc[]
  environs: Map<number, string>
  kills: string[]
  log: string[]
  clock: { now: number }
  ledger: Set<number>
  harness: Set<number>
  background: Map<string, Set<string>>
  cap: number
  guard: ProcessGuard
}

function world(rows: GuardProc[], environs: Record<number, string>, over: { ledger?: number[]; harness?: number[]; cap?: number } = {}): World {
  const w = {
    rows,
    environs: new Map(Object.entries(environs).map(([k, v]) => [Number(k), v])),
    kills: [] as string[],
    log: [] as string[],
    clock: { now: 1_000_000 },
    ledger: new Set(over.ledger ?? []),
    harness: new Set(over.harness ?? []),
    background: new Map<string, Set<string>>(),
    cap: over.cap ?? DEFAULT_CALL_CAP_BYTES
  } as World
  w.guard = new ProcessGuard({
    scan: async () => w.rows.map((r) => ({ ...r })),
    environ: async (pid) => w.environs.get(pid) ?? null,
    kill: (pid, signal) => {
      const there = pid < 0 ? w.rows.some((r) => r.pgid === -pid) : w.rows.some((r) => r.pid === pid)
      if (there) w.kills.push(`${signal} ${pid}`)
      return there
    },
    ledgerPids: () => w.ledger,
    backgroundCalls: (id) => w.background.get(id) ?? new Set(),
    harnessPids: () => w.harness,
    threadOfHarness: (pid) => (pid === 77 ? 'tOf77' : null),
    capBytes: () => w.cap,
    now: () => w.clock.now,
    log: (l) => w.log.push(l),
    ownPid: 42
  })
  return w
}

/** Past the scan-sharing window, so the next read sees the rows as they are now. */
const later = (w: World, ms: number): void => {
  w.clock.now += ms
}

describe('the orphan sweep', () => {
  it('the tinypool workers of a killed vitest are killed after the grace, one line each, SIGKILL after the kill grace', async () => {
    const workers = [1000, 1001].map((pid) => proc(pid, 1, 900, TINYPOOL, 2_800_000))
    const w = world(workers, { 1000: MARKED, 1001: MARKED })
    await w.guard.tick()
    expect(w.kills).toEqual([])
    later(w, ORPHAN_GRACE_MS - 1_000)
    await w.guard.tick()
    expect(w.kills).toEqual([])
    later(w, 1_000)
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM 1000', 'SIGTERM 1001'])
    expect(w.log).toEqual([`[guard] orphan thread=t1 pid=1000 rss=2734MB ${TINYPOOL}`, `[guard] orphan thread=t1 pid=1001 rss=2734MB ${TINYPOOL}`])
    // Still there past the kill grace: SIGKILL, and no second SIGTERM in the same sweep.
    later(w, KILL_GRACE_MS)
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM 1000', 'SIGTERM 1001', 'SIGKILL 1000', 'SIGKILL 1001'])
    expect(w.log).toHaveLength(2)
    // Gone: nothing more.
    w.rows = []
    later(w, 10_000)
    await w.guard.tick()
    expect(w.kills).toHaveLength(4)
  })

  it('a ledger pid, a harness, this process, an unmarked process and a backgrounded call are left alone', async () => {
    const w = world(
      [
        proc(2000, 1, 2000, 'bun run dev'),
        proc(100, 1, 100, 'claude'),
        proc(42, 1, 42, 'electron'),
        proc(3000, 1, 3000, 'sleep 1000'),
        proc(4000, 1, 4000, 'tail -f out.log'),
        proc(4100, 1, 4100, 'bun run dev --port 5174')
      ],
      { 2000: MARKED, 100: MARKED, 42: MARKED, 3000: env({ PATH: '/usr/bin' }), 4000: marked('t1', 'cListed'), 4100: marked('t1', 'cBackground') },
      { ledger: [2000], harness: [100] }
    )
    w.background.set('t1', new Set(['cListed']))
    w.guard.observeEvent(bashCall('t1', 'cBackground', { command: 'bun run dev --port 5174', run_in_background: true }))
    await w.guard.tick()
    later(w, ORPHAN_GRACE_MS + 10_000)
    await w.guard.tick()
    later(w, 10_000)
    await w.guard.tick()
    expect(w.kills).toEqual([])
    expect(w.log).toEqual([])
  })

  it("the gateway's scope and CLAUDE_PID mark a process too, and a live harness pid names its thread", async () => {
    const w = world(
      [proc(5000, 1, 5000, 'node server.js'), proc(5001, 1, 5001, 'bash -c x'), proc(5002, 1, 5002, 'bash -c y')],
      {
        5000: env({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:34695/claude/~t=t9;a=me@x.com;m=claude-opus-5-5' }),
        5001: env({ CLAUDE_PID: '77' }),
        5002: env({ CLAUDE_PID: '78' })
      }
    )
    await w.guard.tick()
    later(w, ORPHAN_GRACE_MS)
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM 5000', 'SIGTERM 5001', 'SIGTERM 5002'])
    expect(w.log.map((l) => l.split(' ')[2])).toEqual(['thread=t9', 'thread=tOf77', 'thread=claude:78'])
  })
})

describe("a call's processes", () => {
  it('the call ending kills its group whole when the group is its own, never the harness', async () => {
    const w = world(
      [proc(100, 50, 100, 'claude'), proc(500, 100, 500, '/bin/bash -c eval bun test'), proc(501, 500, 500, 'node vitest'), proc(502, 501, 500, TINYPOOL), proc(600, 1, 600, 'other')],
      { 500: MARKED, 501: MARKED, 502: MARKED, 600: env({ PATH: '/usr/bin' }) },
      { harness: [100] }
    )
    w.guard.observeEvent(bashCall('t1', 'c1', { command: 'bun test' }))
    expect(w.guard.openCalls()).toEqual(['c1'])
    await w.guard.callEnded('t1', 'c1')
    expect(w.kills).toEqual(['SIGTERM -500'])
    expect(w.guard.openCalls()).toEqual([])
    expect(w.log).toEqual(['[guard] call ended: call=c1 3 processes killed'])
    // The group lingers past the kill grace: SIGKILL at the next sweep.
    later(w, KILL_GRACE_MS + 1)
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM -500', 'SIGKILL -500'])
    // Gone: the sweep forgets it.
    w.rows = w.rows.filter((r) => r.pgid !== 500)
    later(w, 10_000)
    await w.guard.tick()
    expect(w.kills).toHaveLength(2)
  })

  it('a group holding a ledger pid goes pid by pid with the ledger pid spared; a leaderless group of marked processes goes whole; a group with a stranger goes pid by pid', async () => {
    const w = world(
      [
        proc(700, 100, 700, 'bash'),
        proc(701, 700, 700, 'vite'),
        proc(801, 1, 800, 'node w1'),
        proc(802, 1, 800, 'node w2'),
        proc(901, 1, 900, 'node w3'),
        proc(902, 1, 900, 'stranger')
      ],
      { 700: MARKED, 701: MARKED, 801: MARKED, 802: MARKED, 901: MARKED, 902: env({ PATH: '/usr/bin' }) },
      { ledger: [701] }
    )
    await w.guard.callEnded('t1', 'c1')
    expect(w.kills).toEqual(['SIGTERM -800', 'SIGTERM 700', 'SIGTERM 901'])
  })

  it('a call the thread backgrounded keeps its processes: run_in_background, or a task the harness lists', async () => {
    const w = world([proc(500, 100, 500, 'bun run dev'), proc(510, 100, 510, 'tail -f x')], { 500: marked('t1', 'cbg'), 510: marked('t1', 'cl') })
    w.guard.observeEvent(bashCall('t1', 'cbg', { command: 'bun run dev', run_in_background: true }))
    w.guard.observeEvent(bashCall('t1', 'cl', { command: 'tail -f x' }))
    w.background.set('t1', new Set(['cl']))
    await w.guard.callEnded('t1', 'cbg')
    await w.guard.callEnded('t1', 'cl')
    expect(w.kills).toEqual([])
    expect(w.guard.openCalls()).toEqual([])
  })

  it("the turn ending kills every open call of the thread, not another thread's", async () => {
    const w = world([proc(500, 100, 500, 'bun test'), proc(600, 101, 600, 'bun test')], { 500: MARKED, 600: marked('t2', 'c2') })
    w.guard.observeEvent(bashCall('t1', 'c1', { command: 'bun test' }))
    w.guard.observeEvent(bashCall('t2', 'c2', { command: 'bun test' }))
    w.guard.observeEvent(row('t1', { type: 'status', status: 'idle' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(w.kills).toEqual(['SIGTERM -500'])
    expect(w.guard.openCalls()).toEqual(['c2'])
  })

  it('only a whole shell call opens: a partial, a subagent-nested call or another tool never does', () => {
    const w = world([], {})
    w.guard.observeEvent(row('t1', { type: 'tool-call', callId: 'p', name: 'Bash', input: { command: 'bun' }, partial: true }))
    w.guard.observeEvent(row('t1', { type: 'tool-call', callId: 'n', name: 'Bash', input: { command: 'bun' }, parentCallId: 'agent1' }))
    w.guard.observeEvent(row('t1', { type: 'tool-call', callId: 'r', name: 'Read', input: { file_path: '/x' } }))
    expect(w.guard.openCalls()).toEqual([])
  })
})

describe('the memory cap', () => {
  const tree = (rssKb: number): GuardProc[] => [
    proc(100, 50, 100, 'claude'),
    proc(500, 100, 500, '/bin/bash -c eval bunx vitest', 1_000),
    proc(501, 500, 500, 'node vitest', rssKb),
    proc(502, 501, 500, TINYPOOL, rssKb),
    proc(503, 501, 500, TINYPOOL, rssKb)
  ]
  const environs = { 500: MARKED, 501: MARKED, 502: MARKED, 503: MARKED }

  it("a call's processes over the cap are killed, the log and the call's result say so, the result once", async () => {
    const w = world(tree(3 * 1024 * 1024), environs, { harness: [100] })
    w.guard.observeEvent(bashCall('t1', 'c1', { command: 'bunx vitest' }))
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM -500'])
    expect(w.log).toEqual(['[guard] cap thread=t1 call=c1 rss=9217MB over 8192MB: 4 processes killed'])
    expect(w.guard.openCalls()).toEqual([])
    expect(w.guard.tail('c1')).toBe(`${CAP_LINE_PREFIX}: 9.0 GiB in use, over the 8.0 GiB cap per call (setting tools.memoryCapMb).`)
    expect(w.guard.tail('c1')).toBeNull()
    expect(w.guard.tail('other')).toBeNull()
  })

  it('under the cap nothing happens; the setting lowers the cap', async () => {
    const w = world(tree(400 * 1024), environs, { harness: [100] })
    w.guard.observeEvent(bashCall('t1', 'c1', { command: 'bunx vitest' }))
    await w.guard.tick()
    expect(w.kills).toEqual([])
    w.cap = 1 * GiB
    later(w, 10_000)
    await w.guard.tick()
    expect(w.kills).toEqual(['SIGTERM -500'])
    expect(w.log[0]).toContain('rss=1201MB over 1024MB')
  })

  it('the cap weighs only the processes of an open call, never the harness', async () => {
    const w = world([proc(100, 50, 100, 'claude', 20 * 1024 * 1024), proc(500, 100, 500, 'bash', 100)], { 100: MARKED, 500: MARKED }, { harness: [100] })
    w.guard.observeEvent(bashCall('t1', 'c1', { command: 'bun test' }))
    await w.guard.tick()
    expect(w.kills).toEqual([])
  })
})

describe('the marks', () => {
  it('wrapBashCommand exports the thread and the call ahead of the command; unwrapBashCommand gives the command back', () => {
    const wrapped = wrapBashCommand('bun test', 'toolu_01', 't1')
    expect(wrapped).toBe("export TEMP_CODE_THREAD='t1' TEMP_CODE_CALL='toolu_01'; bun test")
    expect(unwrapBashCommand(wrapped)).toBe('bun test')
    expect(unwrapBashCommand('bun test')).toBe('bun test')
    const quoted = wrapBashCommand("echo 'hi'; cd x", "a'b", 't1')
    expect(quoted).toBe("export TEMP_CODE_THREAD='t1' TEMP_CODE_CALL='a'\\''b'; echo 'hi'; cd x")
    expect(unwrapBashCommand(quoted)).toBe("echo 'hi'; cd x")
  })

  it('markersOf reads the marks, the gateway scope and CLAUDE_PID, the mark winning', () => {
    expect(markersOf(null)).toEqual({ threadId: null, callId: null, claudePid: null })
    expect(markersOf(MARKED)).toEqual({ threadId: 't1', callId: 'c1', claudePid: null })
    expect(markersOf(env({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=t9;a=x', TEMP_CODE_THREAD: 't1' }))).toMatchObject({ threadId: 't1', callId: null })
    expect(markersOf(env({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=t9;a=x' }))).toMatchObject({ threadId: 't9', callId: null })
    expect(markersOf(env({ CLAUDE_PID: '77' }))).toEqual({ threadId: null, callId: null, claudePid: 77 })
  })

  it("environFromPsE reads the marks off macOS's ps -E line, where the environment follows the command", () => {
    const line = `/bin/bash -c eval 'bun test' PATH=/usr/bin TEMP_CODE_THREAD=t1 TEMP_CODE_CALL=toolu_01 CLAUDE_PID=77 ANTHROPIC_BASE_URL=http://127.0.0.1:1/claude/~t=t1;a=x HOME=/Users/me\n`
    expect(markersOf(environFromPsE(line))).toEqual({ threadId: 't1', callId: 'toolu_01', claudePid: 77 })
    expect(environFromPsE('node server.js HOME=/Users/me\n')).toBe('')
    expect(markersOf(environFromPsE('node server.js HOME=/Users/me\n'))).toEqual({ threadId: null, callId: null, claudePid: null })
    expect(environFromPsE('')).toBeNull()
  })

  it('parseGuardPs reads the ps rows', () => {
    const rows = parseGuardPs(`   1000     1   900 2800000 ${TINYPOOL}\n\n  12     1    12     100 bash\n`)
    expect(rows).toEqual([
      { pid: 1000, ppid: 1, pgid: 900, rssKb: 2_800_000, args: TINYPOOL },
      { pid: 12, ppid: 1, pgid: 12, rssKb: 100, args: 'bash' }
    ])
  })
})
