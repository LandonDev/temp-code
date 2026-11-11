import { describe, expect, it } from 'vitest'
import type { BenchCall, BenchReport, BenchRun } from './lib/computerBench'
import { fieldWaste, renderFieldWaste } from './lib/fieldWaste'

const call = (tool: string, args: unknown = {}, extra: Partial<BenchCall> = {}): BenchCall => ({
  tool, args, hostMs: 10, rowMs: 20, steps: [], screenshotAsked: false, shots: 0, isError: false, ...extra
})
const run = (calls: BenchCall[], extra: Partial<BenchRun> = {}): BenchRun => ({ model: 'opus', calls, ...extra } as BenchRun)
const report = (...runs: BenchRun[]): Pick<BenchReport, 'runs' | 'models'> => ({ runs, models: [] })

describe('fieldWaste', () => {
  it('counts each of the five buckets per model from saved JSON', () => {
    const saved = JSON.parse(JSON.stringify(report(run([
      call('computer_act', { app: 'TextEdit', window: 'Note' }),
      call('computer_observe', { app: 'TextEdit', window: 'Note' }),
      call('computer_act', {}, { isError: true, answerHead: 'no window of Chrome matches "Report"' }),
      call('computer_act', {}, { isError: true, answerHead: 'invalid arguments: element is required' }),
      call('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'screenshot' }] }),
      call('computer_observe', { screenshot: true })
    ], { toolSearches: [{ tool: 'ToolSearch', args: { query: 'computer' } }] }), run([], { model: 'sol' }))))
    expect(fieldWaste(saved)).toEqual([
      { model: 'opus', rereads: 1, windowMisses: 1, refusedArguments: 1, screenshotCalls: 2, toolSearches: 1 },
      { model: 'sol', rereads: 0, windowMisses: 0, refusedArguments: 0, screenshotCalls: 0, toolSearches: 0 }
    ])
  })

  it('requires an immediate read of the same explicit app and window', () => {
    const target = { app: 'TextEdit', window: 'Note' }
    expect(fieldWaste(report(run([
      call('mcp__app__computer_batch', target, { order: 0 }),
      call('computer_observe', target, { order: 2 }), // allowed tool between
      call('computer_act', target),
      call('computer_observe', { ...target, window: 'Other' }),
      call('computer_act', target),
      call('computer_observe', { ...target, app: 'Notes' }),
      call('computer_act', {}), call('computer_observe', {}),
      call('computer_act', { app: 'TextEdit' }), call('computer_observe', { app: 'TextEdit' })
    ])))[0].rereads).toBe(1)
    // A task boundary breaks adjacency too.
    expect(fieldWaste(report(run([call('computer_act', target)]), run([call('computer_observe', target)])))[0].rereads).toBe(0)
  })

  it('counts screenshot calls once, excludes zoom and pictures returned by thin trees', () => {
    const saved = report(run([
      call('computer_screenshot'), call('computer_act', { action: 'screenshot' }),
      call('computer_act', {}, { steps: [{ action: 'screenshot', tier: null, ok: true }] }),
      call('computer_act', { action: 'zoom' }, { screenshotAsked: true }),
      call('computer_observe', {}, { shots: 1 }),
      call('computer_act', { screenshot: true }),
      call('computer_act', {}, { answerHead: 'failed: invalid arguments elsewhere' }),
      call('computer_act', {}, { answerHead: 'a no window of line elsewhere' })
    ]))
    expect(fieldWaste(saved)[0]).toMatchObject({ screenshotCalls: 3, refusedArguments: 0, windowMisses: 0 })
  })

  it('handles older reports without args or searches and prints zero rows for declared models', () => {
    const old = call('computer_observe'); delete old.args
    const saved = { models: [{ model: 'unused' }], runs: [run([old])] }
    expect(renderFieldWaste(saved)).toContain('| unused | 0 | 0 | 0 | 0 | 0 |')
    expect(renderFieldWaste(saved)).toContain('| model | re-read | window miss | refused argument | screenshot call | tool search |')
  })
})
