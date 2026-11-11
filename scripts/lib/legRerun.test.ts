import { describe, expect, it } from 'vitest'
import { flakeLine, flakesInLog, legRerunVerdict, needsLegRerun, type LegStep } from './legRerun'

const passed = (name: string): LegStep => ({ name, outcome: 'passed' })
const failed = (name: string, why: string): LegStep => ({ name, outcome: 'failed', why })
const skipped = (name: string): LegStep => ({ name, outcome: 'skipped', why: 'an earlier step failed' })

// v1.0.341's publish, 2026-11-11
const first = [passed('fallbacks 6'), failed('fallbacks 7: a scroll moves the bar', 'the bar moved; saw {"effect":"none"}'), skipped('fallbacks 8')]

describe('the leg rerun', () => {
  it('reruns a leg only under --gate, with a failed step, and not after the person aborted it', () => {
    expect(needsLegRerun(first, true, false)).toBe(true)
    expect(needsLegRerun(first, false, false)).toBe(false)
    expect(needsLegRerun(first, true, true)).toBe(false)
    expect(needsLegRerun([passed('fallbacks 6'), skipped('fallbacks 8')], true, false)).toBe(false)
  })

  it('names the first run’s failures as flakes when the rerun passes whole', () => {
    const v = legRerunVerdict('fallbacks', first, [passed('fallbacks 6'), passed('fallbacks 7: a scroll moves the bar'), passed('fallbacks 8')])
    expect(v.red).toBe(false)
    expect(v.flakes).toEqual([{ leg: 'fallbacks', step: 'fallbacks 7: a scroll moves the bar', why: 'the bar moved; saw {"effect":"none"}' }])
    expect(flakeLine(v.flakes[0])).toBe('flake: fallbacks leg, fallbacks 7: a scroll moves the bar: the bar moved; saw {"effect":"none"}')
  })

  it('is red when the rerun fails too, whichever step', () => {
    expect(legRerunVerdict('web', [failed('web: pick', 'restored failed')], [passed('web: pick'), failed('web: checkbox', 'not checked')])).toEqual({ red: true, flakes: [] })
    expect(legRerunVerdict('web', [failed('web: pick', 'restored failed')], [failed('web: pick', 'restored failed')])).toEqual({ red: true, flakes: [] })
  })

  it('is red when the rerun skips the step that failed or never reaches it: a skip proves nothing', () => {
    expect(legRerunVerdict('fallbacks', first, [passed('fallbacks 6'), skipped('fallbacks 7: a scroll moves the bar'), passed('fallbacks 8')])).toEqual({ red: true, flakes: [] })
    expect(legRerunVerdict('fallbacks', first, [passed('fallbacks 6')])).toEqual({ red: true, flakes: [] })
  })

  it('reads the flake lines back from a step’s log', () => {
    const log = ['✓ fallbacks 6 2436ms', 'flake: fallbacks leg, fallbacks 7: the bar moved', 'report: /tmp/x.json', 'flake: web leg, web: pick: restored failed'].join('\n')
    expect(flakesInLog(log)).toEqual(['fallbacks leg, fallbacks 7: the bar moved', 'web leg, web: pick: restored failed'])
    expect(flakesInLog('✓ all\n')).toEqual([])
  })
})
