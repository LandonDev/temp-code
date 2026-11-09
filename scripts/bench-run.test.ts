import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, EventRow } from '../src/shared/events'
import { BENCH_MODELS, DARK_SCREEN, NEVER_QUIET, keepFront, keepReport, laneOrder, macReady, parseBenchArgs, readRun, runStamp, unionMs, waitForQuiet, type HostCall, type MacProbe } from './lib/benchRun'
import { runHostMs, summarize, type BenchRun } from './lib/computerBench'

describe('parseBenchArgs', () => {
  it('reads every flag', () => {
    expect(parseBenchArgs([])).toEqual({ mode: 'hand', models: null, tasks: null, runs: null, session: false, rebaseline: false, judge: null })
    expect(parseBenchArgs(['--gate'])).toMatchObject({ mode: 'gate' })
    expect(parseBenchArgs(['--', '--gate'])).toMatchObject({ mode: 'gate' })
    expect(parseBenchArgs(['--report-only', '--models', 'gpt-6.1-sol, claude-opus-5-5', '--tasks', 'chrome-read'])).toMatchObject({
      mode: 'report-only',
      models: ['gpt-6.1-sol', 'claude-opus-5-5'],
      tasks: ['chrome-read']
    })
    expect(parseBenchArgs(['--runs', '3', '--session', '--rebaseline'])).toMatchObject({ mode: 'hand', runs: 3, session: true, rebaseline: true })
    expect(parseBenchArgs(['--judge', '/tmp/r.json'])).toMatchObject({ judge: '/tmp/r.json' })
    expect(parseBenchArgs(['--reference', 'codex', '--tasks', 'textedit-write'])).toMatchObject({ mode: 'reference', tasks: ['textedit-write'] })
  })

  it('refuses what the gate never does, and nonsense', () => {
    expect(() => parseBenchArgs(['--gate', '--runs', '3'])).toThrow(/--runs is for a hand run/)
    // the plan's full hand table: every run, judged, nothing failed or written
    expect(parseBenchArgs(['--runs', '3', '--report-only'])).toMatchObject({ mode: 'report-only', runs: 3 })
    expect(() => parseBenchArgs(['--gate', '--session'])).toThrow(/never runs in the gate/)
    expect(() => parseBenchArgs(['--report-only', '--session'])).toThrow(/never runs in the gate/)
    expect(() => parseBenchArgs(['--gate', '--report-only'])).toThrow(/go alone/)
    expect(() => parseBenchArgs(['--reference', 'cua'])).toThrow(/takes codex/)
    expect(() => parseBenchArgs(['--reference', 'codex', '--rebaseline'])).toThrow(/never writes/)
    expect(() => parseBenchArgs(['--report-only', '--rebaseline'])).toThrow(/never writes/)
    expect(() => parseBenchArgs(['--runs', '0'])).toThrow(/1 to 10/)
    expect(() => parseBenchArgs(['--models'])).toThrow(/needs a value/)
    expect(() => parseBenchArgs(['--fast'])).toThrow(/unknown argument --fast/)
  })
})

describe('lanes', () => {
  it('runs the three models, each at medium', () => {
    expect(BENCH_MODELS.map((m) => [m.model, m.provider, m.effort])).toEqual([
      ['claude-opus-5-5', 'claude', 'medium'],
      ['gpt-6.1-sol', 'codex', 'medium'],
      ['muse-wonder-1.0', 'muse', 'medium']
    ])
  })

  it('turns each lane’s list by twice its index', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(laneOrder(tasks, 0)).toEqual(tasks)
    expect(laneOrder(tasks, 1)).toEqual(['c', 'd', 'e', 'f', 'g', 'a', 'b'])
    expect(laneOrder(tasks, 2)).toEqual(['e', 'f', 'g', 'a', 'b', 'c', 'd'])
    expect(laneOrder(['a', 'b'], 1)).toEqual(['a', 'b'])
    expect(laneOrder([], 2)).toEqual([])
  })
})

describe('readRun', () => {
  let seq = 0
  const row = (ts: number, event: AgentEvent): EventRow => ({ sessionId: 't', seq: ++seq, ts, event })
  const call = (ts: number, callId: string, name: string, input: unknown = {}, partial?: boolean): EventRow =>
    row(ts, { type: 'tool-call', callId, name, input, ...(partial ? { partial } : {}) } as AgentEvent)
  const result = (ts: number, callId: string): EventRow => row(ts, { type: 'tool-result', callId, output: 'ok', isError: false })
  const host = (tool: string, hostMs: number, steps: string[] = []): HostCall => ({ tool, args: {}, startedAt: 0, hostMs, steps, shots: 0, isError: false })

  it('joins each computer call to its host call, with row time, think time and the tools off the route', () => {
    const rows = [
      row(1000, { type: 'status', status: 'running' }),
      call(1500, 's1', 'ToolSearch'),
      result(1600, 's1'),
      call(2900, 'c1', 'mcp__app__computer_observe', { app: 'TextEdit', screenshot: true }, true),
      call(3000, 'c1', 'mcp__app__computer_observe', { app: 'TextEdit', screenshot: true }),
      result(3400, 'c1'),
      call(5000, 'c2', 'mcp__app__computer_act', { app: 'TextEdit', action: 'set_value', element: 3, value: 'x' }),
      result(5200, 'c2'),
      call(6000, 'b1', 'Bash', { command: 'ls' }),
      result(6100, 'b1'),
      row(6500, { type: 'turn-complete', inputTokens: 1200, outputTokens: 80 })
    ]
    const facts = readRun(rows, [host('computer_observe', 310), host('computer_act', 150, ['set_value [3] · ax · changed'])], 1000, 6500)
    expect(facts.calls).toEqual([
      { tool: 'computer_observe', hostMs: 310, rowMs: 400, steps: [], screenshotAsked: true, shots: 0, isError: false },
      { tool: 'computer_act', hostMs: 150, rowMs: 200, steps: [{ action: 'set_value', tier: 'ax', effect: 'changed', ok: true }], screenshotAsked: false, shots: 0, isError: false }
    ])
    expect(facts.otherTools).toEqual(['Bash'])
    expect(facts.wallMs).toBe(5500)
    // 5500 less the 100 + 400 + 200 + 100 ms some tool was open
    expect(facts.thinkMs).toBe(4700)
    expect(facts.tokens).toEqual({ input: 1200, output: 80 })
  })

  it('counts a call refused before the host, with no host time', () => {
    const rows = [call(100, 'c1', 'mcp__app__computer_act', {}), result(120, 'c1'), call(200, 'c2', 'mcp__app__computer_act', {}), result(400, 'c2')]
    const facts = readRun(rows, [host('computer_act', 180)], 0, 500)
    expect(facts.calls.map((c) => c.hostMs)).toEqual([180, null])
    const run = { calls: facts.calls } as BenchRun
    expect(runHostMs(run)).toBe(180)
  })

  it('records the cards with their confirm kind, and sums tokens over both turns', () => {
    const rows = [
      row(10, { type: 'approval-request', requestId: 'r1', toolName: 'mcp__app__computer_act', input: { confirm: { kind: 'delete' } }, title: 'Delete in Google Chrome' }),
      row(20, { type: 'turn-complete', inputTokens: 100, outputTokens: 10 }),
      row(30, { type: 'turn-complete', inputTokens: 50, outputTokens: 5 })
    ]
    const facts = readRun(rows, [], 0, 40)
    expect(facts.cards).toEqual([{ kind: 'delete', title: 'Delete in Google Chrome' }])
    expect(facts.tokens).toEqual({ input: 150, output: 15 })
    expect(readRun([row(5, { type: 'usage', inputTokens: 9, outputTokens: 1 })], [], 0, 10).tokens).toEqual({ input: 9, output: 1 })
    expect(readRun([], [], 0, 10).tokens).toBeUndefined()
  })

  it('takes Codex’s own computer tool as the computer tool for the reference pass', () => {
    const rows = [call(100, 'x1', 'cua_repl', { code: 'click(1)' }), result(900, 'x1')]
    const facts = readRun(rows, [], 0, 1000, (name) => name === 'cua_repl')
    expect(facts.calls).toEqual([{ tool: 'cua_repl', hostMs: null, rowMs: 800, steps: [], screenshotAsked: false, shots: 0, isError: false }])
    expect(facts.otherTools).toEqual([])
    expect(readRun(rows, [], 0, 1000).otherTools).toEqual(['cua_repl'])
  })

  it('reads a batch with a screenshot step as one that asked for a picture', () => {
    const rows = [call(1, 'c1', 'mcp__app__computer_batch', { actions: [{ action: 'left_click', element: 2 }, { action: 'screenshot' }] }), result(2, 'c1')]
    expect(readRun(rows, [], 0, 3).calls[0].screenshotAsked).toBe(true)
    expect(summarize([{ ...({} as BenchRun), model: 'm', task: 't', taskVersion: 1, outcome: 'passed', calls: readRun(rows, [], 0, 3).calls, otherTools: [], stepBudget: 6, front: { before: '', after: '', bounced: false, personActive: false, benchInFront: false }, wallMs: 3, thinkMs: 2, queuedMs: 0 } as BenchRun])[0].shotsAskedMedian).toBe(1)
  })

  it('unions overlapping spans', () => {
    expect(unionMs([])).toBe(0)
    expect(unionMs([[0, 10], [5, 15], [20, 25]])).toBe(20)
    expect(unionMs([[5, 5], [10, 8]])).toBe(0)
  })
})

describe('the person keeps the Mac', () => {
  const idle = (seconds: number[]): Pick<MacProbe, 'idleSeconds'> => {
    let i = 0
    return { idleSeconds: async () => seconds[Math.min(i++, seconds.length - 1)] }
  }
  const noWait = async (): Promise<void> => {}

  it('launches only after 5 s with no input, polled every 500 ms, and gives up after 60 s', async () => {
    expect(await waitForQuiet(idle([6]), { wait: noWait })).toBe(true)
    const waits: number[] = []
    expect(await waitForQuiet(idle([0, 1, 2, 5]), { wait: async (ms) => void waits.push(ms) })).toBe(true)
    expect(waits).toEqual([500, 500, 500])
    waits.length = 0
    expect(await waitForQuiet(idle([1]), { wait: async (ms) => void waits.push(ms) })).toBe(false)
    expect(waits).toHaveLength(120)
  })

  it('ungated, waits only for an unlocked, lit screen; gated, for the quiet', async () => {
    const screens = (states: { locked: boolean; asleep: boolean }[]) => {
      let i = 0
      // the person is typing all along: an ungated run never looks at it
      return { idleSeconds: async () => 0, screen: async () => states[Math.min(i++, states.length - 1)] }
    }
    const lit = { locked: false, asleep: false }
    expect(await macReady(screens([lit]), true, { wait: noWait })).toBeNull()
    expect(await macReady(screens([{ locked: true, asleep: false }, { locked: false, asleep: true }, lit]), true, { wait: noWait })).toBeNull()
    expect(await macReady(screens([{ locked: true, asleep: false }]), true, { wait: noWait })).toBe(DARK_SCREEN)
    expect(await macReady(screens([lit]), false, { wait: noWait })).toBe(NEVER_QUIET)
    expect(await macReady({ idleSeconds: async () => 9, screen: async () => lit }, false, { wait: noWait })).toBeNull()
  })

  it('sends a scratch app that came forward back, and says when it could not', async () => {
    const before = { pid: 10, bundleId: 'com.apple.Terminal' }
    const probe = (fronts: number[], activated: string[] = []): MacProbe => {
      let i = 0
      return {
        idleSeconds: async () => 9,
        screen: async () => ({ locked: false, asleep: false }),
        frontmost: async () => ({ pid: fronts[Math.min(i++, fronts.length - 1)], bundleId: null }),
        activate: async (id) => void activated.push(id)
      }
    }
    expect(await keepFront(probe([10]), 77, before)).toBe('kept')
    const activated: string[] = []
    expect(await keepFront(probe([77, 10], activated), 77, before)).toBe('bounced')
    expect(activated).toEqual(['com.apple.Terminal'])
    expect(await keepFront(probe([77, 77]), 77, before)).toBe('took')
    expect(await keepFront(probe([77, 77]), 77, { pid: 10, bundleId: null })).toBe('took')
  })
})

describe('keepReport', () => {
  it('writes last.json and keeps the 20 newest runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-reports-'))
    try {
      for (let i = 0; i < 23; i++) keepReport(dir, `{"n":${i}}`, runStamp(Date.UTC(2026, 10, 9, 2, i)))
      expect(readFileSync(join(dir, 'last.json'), 'utf8')).toBe('{"n":22}')
      const kept = readdirSync(join(dir, 'runs')).sort()
      expect(kept).toHaveLength(20)
      expect(kept[0]).toBe('20261109-020300.json')
      expect(kept.at(-1)).toBe('20261109-022200.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the dev instance', () => {
  it('finds the Electron binary in its process group, never a helper or another group', async () => {
    const { electronMainIn, devEnv } = await import('./lib/devInstance')
    const ps = [
      '  501   500 /Users/me/tc/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      '  502   500 /Users/me/tc/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)',
      '  777   700 /Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Electron',
      '  500   500 node'
    ].join('\n')
    expect(electronMainIn(ps, 500)).toBe(501)
    expect(electronMainIn(ps, 600)).toBeNull()
    const env = devEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', GIT_INDEX_FILE: 'x' }, '/tmp/run', 9333)
    expect(env).toEqual({
      PATH: '/bin',
      TEMP_CODE_USER_DATA: '/tmp/run/dev',
      TEMP_CODE_SOAK_WINDOW: '1',
      TEMP_CODE_ALIAX_DATA_DIR: '/tmp/run/aliax',
      TEMP_CODE_WARM_HARNESS: '0',
      TEMP_CODE_REMOTE_PORT: '0',
      TEMP_CODE_DEBUG_PORT: '9333'
    })
  })
})
