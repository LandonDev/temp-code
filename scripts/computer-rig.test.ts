import { afterEach, describe, expect, it } from 'vitest'
import { computerHarness, type ComputerHarness } from '../src/main/server/computer/runHarness'
import { stepsOf } from './lib/computerBench'
import { DEFAULT_LANE, LanePins, RIG_QUERIES, recordCalls, scratchArgs, taskReader } from './lib/computerRig'
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

  it('pins every name a model may call the dev instance and System Settings by', () => {
    expect(RIG_QUERIES.Electron).toEqual(expect.arrayContaining(['electron', 'tempcode']))
    expect(RIG_QUERIES['System Settings']).toEqual(expect.arrayContaining(['system settings', 'com.apple.systempreferences']))
  })
})

describe('scratchArgs', () => {
  it('launches with the fixture recording’s flags, in the background', () => {
    expect(scratchArgs('Google Chrome', 'file:///b.html#seed=3', '/tmp/p')).toEqual([
      '-n', '-g', '-a', 'Google Chrome', '--args', '--user-data-dir=/tmp/p', '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', 'file:///b.html#seed=3'
    ])
    expect(scratchArgs('TextEdit', '/tmp/x.rtf', '')).toEqual([
      '-n', '-g', '-a', 'TextEdit', '/tmp/x.rtf', '--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-NSDocumentSaveNewDocumentsToCloud', 'NO'
    ])
    expect(scratchArgs('System Settings', '', '')).toEqual(['-g', '-b', 'com.apple.systempreferences'])
    expect(() => scratchArgs('Electron', '', '')).toThrow(/started by its task/)
  })
})

describe('recordCalls', () => {
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
