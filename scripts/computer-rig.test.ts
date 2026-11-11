import { afterEach, describe, expect, it } from 'vitest'
import { computerHarness, type ComputerHarness } from '../src/main/server/computer/runHarness'
import { stepsOf } from './lib/computerBench'
import { CHROME_DRAW_COVERED } from './lib/settleFront'
import { DEFAULT_LANE, LanePins, RIG_QUERIES, recordCalls, recordStepWaits, scratchArgs, taskReader } from './lib/computerRig'
import type { ComputerSessions } from '../src/main/server/computer/sessions'
import { StateGetParamsSchema } from '../src/shared/computer/protocol'

const harnesses: ComputerHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

describe('LanePins', () => {
  it('resolves a query to the pid of the lane in scope only', () => {
    const pins = new LanePins()
    pins.pin('claude', 'TextEdit', 101)
    pins.pin('codex', 'TextEdit', 202)
    pins.pin('codex', 'Google Chrome', 303)
    pins.bind('t-claude', 'claude')
    pins.bind('t-codex', 'codex')
    expect(pins.within('t-claude', () => pins.resolve('TextEdit'))).toEqual({ pid: 101 })
    expect(pins.within('t-codex', () => pins.resolve('com.apple.TextEdit'))).toEqual({ pid: 202 })
    expect(pins.within('t-codex', () => pins.resolve(' Chrome '))).toEqual({ pid: 303 })
    // claude's lane has no Chrome: the normal match, never another lane's window
    expect(pins.within('t-claude', () => pins.resolve('Google Chrome'))).toBeNull()
    expect(pins.within('t-claude', () => pins.resolve('Notes'))).toBeNull()
    // outside any thread, and for an unbound one, the default lane
    expect(pins.resolve('TextEdit')).toBeNull()
    pins.pin(DEFAULT_LANE, 'TextEdit', 9)
    expect(pins.within('t-unbound', () => pins.resolve('textedit'))).toEqual({ pid: 9 })
    pins.unpin('codex')
    expect(pins.within('t-codex', () => pins.resolve('TextEdit'))).toBeNull()
    expect(pins.pids('claude')).toEqual([101])
  })

  it('answers every pid of every lane, so a launch never takes another lane\'s scratch app for the person\'s', () => {
    const pins = new LanePins()
    pins.pin('claude', 'Google Chrome', 11)
    pins.pin('codex', 'Google Chrome', 12)
    pins.pin('codex', 'Electron', 13)
    expect([...pins.all()].sort()).toEqual([11, 12, 13])
    pins.unpin('codex')
    expect([...pins.all()]).toEqual([11])
  })

  it('pins every name a model may call the dev instance and System Settings by', () => {
    expect(RIG_QUERIES.Electron).toEqual(expect.arrayContaining(['electron', 'tempcode']))
    expect(RIG_QUERIES['System Settings']).toEqual(expect.arrayContaining(['system settings', 'com.apple.systempreferences']))
  })
})

describe('scratchArgs', () => {
  it('launches in the background, Chrome with the web leg’s switches that keep a covered page drawn', () => {
    expect(scratchArgs('Google Chrome', 'file:///b.html#seed=3', '/tmp/p')).toEqual([
      '-n', '-g', '-a', 'Google Chrome', '--args', '--user-data-dir=/tmp/p', '--no-first-run', '--no-default-browser-check', ...CHROME_DRAW_COVERED, 'file:///b.html#seed=3'
    ])
    expect(CHROME_DRAW_COVERED).toEqual(['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--force-renderer-accessibility'])
    expect(scratchArgs('TextEdit', '/tmp/x.rtf', '')).toEqual([
      '-n', '-g', '-a', 'TextEdit', '/tmp/x.rtf', '--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-NSDocumentSaveNewDocumentsToCloud', 'NO'
    ])
    expect(scratchArgs('System Settings', '', '')).toEqual(['-g', '-b', 'com.apple.systempreferences'])
    expect(() => scratchArgs('Electron', '', '')).toThrow(/started by its task/)
  })
})

describe('plain scratch Chrome', () => {
  it('uses the suite.py flags and fixed cover frame only for field runs', () => {
    const plain = scratchArgs('Google Chrome', 'file:///front.html', '/tmp/profile', ['file:///report.html'], { plainChrome: true })
    expect(plain).not.toContain('--force-renderer-accessibility')
    expect(plain).toEqual(['-n', '-g', '-a', 'Google Chrome', '--args', '--user-data-dir=/tmp/profile', '--no-first-run', '--no-default-browser-check', '--window-position=80,80', '--window-size=1000,800', 'file:///front.html', 'file:///report.html'])
    expect(scratchArgs('Google Chrome', 'file:///front.html', '/tmp/profile')).toContain('--force-renderer-accessibility')
  })
})

describe('recordCalls', () => {
  it('keeps host-provided waits, including a wait with no counted change', async () => {
    const wait = { waitedMs: 750, reason: 'max' as const, gapCounts: Array(11).fill(0) }
    const sessions = { run: async () => ({
      steps: ['left_click [2] · ax · no change seen'], waits: [wait], shots: [], isError: false, body: null
    }) } as unknown as ComputerSessions
    const rec = recordCalls(sessions, new LanePins())
    await sessions.run({ threadId: 't' }, 'computer_act', { action: 'left_click', element: 2 })
    expect(stepsOf(rec.calls('t')[0].steps, rec.calls('t')[0].waits)[0].wait).toEqual(wait)
    expect(rec.calls('t')[0].answerHead).toBeUndefined()
  })

  it('records the first line of a thrown error', async () => {
    const sessions = { run: async () => { throw new Error('invalid arguments: bad target\nmore detail') } } as unknown as ComputerSessions
    const rec = recordCalls(sessions, new LanePins())
    await expect(sessions.run({ threadId: 't' }, 'computer_act', {})).rejects.toThrow('bad target')
    expect(rec.calls('t')[0]).toMatchObject({ isError: true, answerHead: 'invalid arguments: bad target' })
  })

  it('keeps wait reports across segments in each call’s async scope and bounds error heads', async () => {
    const wait = { waitedMs: 75, reason: 'quiet' as const, firstChangeMs: 25, gapCounts: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], settled: true, busy: false }
    const sessions = { run: async (ctx: { threadId: string }) => {
      recordStepWaits([{ index: 0, action: 'left_click', status: 'failed', error: { kind: 'needs_tier', message: 'needs process' } },
        { index: 1, action: 'key', status: 'not-run' }])
      recordStepWaits([{ index: 0, action: 'left_click', status: 'ok', tier: 'ax', effect: 'changed', waited: wait }])
      await Promise.resolve()
      recordStepWaits([{ index: 0, action: 'key', status: 'ok', tier: 'process', effect: 'none' }])
      return { steps: ['left_click "Team" [52] menu item · ax · changed', 'key Return · process · no change seen'], shots: [], isError: true, body: `no window of ${ctx.threadId} matches ` + 'x'.repeat(250) + '\nmore' }
    } } as unknown as ComputerSessions
    const rec = recordCalls(sessions, new LanePins())
    await Promise.all(['one', 'two'].map((threadId) => sessions.run({ threadId, callId: `call-${threadId}` }, 'computer_batch', { app: threadId })))
    for (const threadId of ['one', 'two']) {
      const saved = JSON.parse(JSON.stringify(rec.calls(threadId)))[0]
      expect(saved.args).toEqual({ app: threadId })
      expect(saved.callId).toBe(`call-${threadId}`)
      expect(saved.waits).toEqual([{ waitedMs: 75, reason: 'quiet', firstChangeMs: 25, gapCounts: wait.gapCounts }, null])
      expect(saved.answerHead).toHaveLength(200)
      expect(saved.answerHead).toMatch(new RegExp(`^no window of ${threadId}`))
      expect(stepsOf(saved.steps, saved.waits)[0].wait?.firstChangeMs).toBe(25)
    }
  })

  it('records each call’s host time, step lines and shots under its thread, in its lane', async () => {
    const pins = new LanePins()
    const h = computerHarness({ resolveApp: (q) => pins.resolve(q) })
    harnesses.push(h)
    let t = 1000
    const rec = recordCalls(h.sessions, pins, () => (t += 40))
    pins.bind('t1', 'claude')
    pins.pin('claude', 'TextEdit', 16800)
    await h.sessions.run({ threadId: 't1' }, 'computer_observe', { app: 'TextEdit', screenshot: true })
    await h.sessions.run({ threadId: 't1' }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    const calls = rec.calls('t1')
    expect(calls.map((c) => [c.tool, c.hostMs, c.isError])).toEqual([
      ['computer_observe', 40, false],
      ['computer_act', 40, false]
    ])
    expect(calls[0].shots).toBeGreaterThan(0)
    expect(stepsOf(calls[1].steps)).toEqual([expect.objectContaining({ action: 'left_click', ok: true })])
    // the lane's pin reached the service
    expect(h.requests().filter((r) => r.method === 'state.get').at(-1)!.params).toMatchObject({ app: { pid: 16800 } })
    expect(rec.calls('t2')).toEqual([])
    rec.clear('t1')
    expect(rec.calls('t1')).toEqual([])
  })

  it('samples target coverage at call entry and keeps it on a failed call', async () => {
    const pins = new LanePins()
    const h = computerHarness()
    harnesses.push(h)
    const sampled: string[] = []
    let covered = true
    const rec = recordCalls(h.sessions, pins, Date.now, (threadId) => {
      sampled.push(threadId)
      return { window: 42, covered, fraction: covered ? 1 : 0 }
    })
    await h.sessions.run({ threadId: 't1' }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: 999 })
    covered = false
    await h.sessions.run({ threadId: 't1' }, 'computer_observe', { app: 'TextEdit' })
    expect(sampled).toEqual(['t1', 't1'])
    expect(rec.calls('t1').map((c) => c.coverage?.covered)).toEqual([true, false])
    expect(rec.calls('t1')[0].isError).toBe(true)
  })

  it('records a refusal as an error call', async () => {
    const pins = new LanePins()
    const h = computerHarness()
    harnesses.push(h)
    const rec = recordCalls(h.sessions, pins)
    const o = await h.sessions.run({ threadId: 't1' }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: 999 })
    expect(o.isError).toBe(true)
    expect(rec.calls('t1')).toEqual([expect.objectContaining({ tool: 'computer_act', isError: true })])
  })
})

describe('taskReader', () => {
  it('reads an element with the epoch of the full read that numbered it', async () => {
    const asked: Record<string, unknown>[] = []
    const proof = async (_m: 'state.get', params: Record<string, unknown>) => {
      // the wire's own rule: an element read without its epoch is refused
      StateGetParamsSchema.parse(params)
      asked.push(params)
      return { epoch: 'ep-7', text: 'app "TextEdit" · window "n0.rtf" · 800×600\n[1] window "n0.rtf"\n  [3] text area = "x"', stats: { thin: false } }
    }
    const r = taskReader(proof as never, () => 42, 'bench-proof', async () => ({ code: 0, stdout: '', stderr: '' }))
    await expect(r.element('TextEdit', 'n0', 3)).rejects.toThrow(/read TextEdit before/)
    await r.read('TextEdit', 'n0')
    await r.element('TextEdit', 'n0', 3)
    expect(asked.map((p) => [p.mode, p.element, p.epoch])).toEqual([
      ['full', undefined, undefined],
      [undefined, 3, 'ep-7']
    ])
    expect(asked[1]).toMatchObject({ session: 'bench-proof', app: { pid: 42 }, window: { title: 'n0' } })
  })
})
