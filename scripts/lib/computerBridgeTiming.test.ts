import { describe, expect, it } from 'vitest'
import { BRIDGE_TIMING_RULE, judgeBridgeTiming, median, ownMs, p90, timingRows, timingTable, type TimingKind, type TimingSample } from './computerBridgeTiming'

/** Ten warm pairs of a kind after one cold pair; `added` per pair, the legs the same each time. */
function pairs(kind: TimingKind, added: number[], legs = { box: 4, transit: 3, mac: 210, run: 200, service: 190, waited: 12, shotChars: 0 }): TimingSample[] {
  const out: TimingSample[] = [{ kind, pair: 0, bridgedMs: 900, localMs: 400, legs }]
  added.forEach((a, i) => out.push({ kind, pair: i + 1, bridgedMs: 200 + a, localMs: 200, legs }))
  return out
}
const ten = (v: number): number[] => Array.from({ length: 10 }, () => v)
const all = (added: number[]): TimingSample[] => [...pairs('observe', added), ...pairs('observe-shot', added), ...pairs('set-value', added)]

describe('the bridge timing judge', () => {
  it('takes medians and nearest-rank p90', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBe(9)
    expect(p90([5])).toBe(5)
    expect(median([])).toBeNull()
  })

  it('passes pairs inside the loopback bound and keeps the cold pair apart', () => {
    const v = judgeBridgeTiming(all(ten(20)), 'gate')
    expect(v).toMatchObject({ ok: true, failures: [] })
    const row = v.rows.find((r) => r.kind === 'observe')!
    // the cold pair's 500 ms is reported, never in the medians
    expect(row).toMatchObject({ n: 10, added: { median: 20, p90: 20 }, cold: { bridgedMs: 900, localMs: 400 }, own: 14 })
  })

  it('fails a median over 40, a p90 over 100 and an own part over 25, each by name', () => {
    expect(judgeBridgeTiming(all(ten(BRIDGE_TIMING_RULE.addedMedianMs + 1)), 'gate').failures).toContain('observe: added 41 ms median, over 40')
    const spiky = [...ten(10).slice(0, 8), 150, 150]
    expect(judgeBridgeTiming(all(spiky), 'gate').failures).toContain('set-value: added 150 ms p90, over 100')
    const slowBox = [...pairs('observe', ten(20), { box: 30, transit: 3, mac: 210, run: 200, service: 190, waited: 0, shotChars: 0 }), ...pairs('observe-shot', ten(20)), ...pairs('set-value', ten(20))]
    expect(judgeBridgeTiming(slowBox, 'gate').failures).toEqual(["observe: the box's own work and the Mac's wrapper 40 ms median, over 25"])
  })

  it('judges the full mode against its own round trip, pictures reported and never judged', () => {
    const samples = [...pairs('observe', ten(71)), ...pairs('observe-shot', ten(900)), ...pairs('set-value', ten(80))]
    expect(judgeBridgeTiming(samples, 'full', { roundTripMs: 45 })).toMatchObject({ ok: true })
    expect(judgeBridgeTiming(samples, 'full', { roundTripMs: 30 }).failures).toEqual(['observe: added 71 ms median, over the round trip 30 + 40', 'set-value: added 80 ms median, over the round trip 30 + 40'])
    expect(judgeBridgeTiming(samples, 'full').failures).toContain('full mode: no measured round trip to judge against')
    expect(timingRows(samples, 'full').find((r) => r.kind === 'observe-shot')!.judged).toBe(false)
  })

  it('skips a missing picture leg by name, and fails a judged kind that never ran', () => {
    const noShots = [...pairs('observe', ten(20)), ...pairs('set-value', ten(20))]
    const skipped = judgeBridgeTiming(noShots, 'gate', { skipped: { 'observe-shot': 'Screen Recording is off' } })
    expect(skipped.ok).toBe(true)
    expect(timingTable(skipped)).toContain('observe-shot  skipped: Screen Recording is off')
    expect(judgeBridgeTiming(noShots, 'gate').failures).toEqual(['observe-shot: no pairs ran'])
  })

  it('needs the timing lines to split the legs on loopback', () => {
    const blind = all(ten(20)).map((s) => ({ ...s, legs: null }))
    expect(judgeBridgeTiming(blind, 'gate').failures).toEqual(TIMING_LINES_MISSING)
    expect(ownMs({ box: 2, mac: 50, run: 45 })).toBe(7)
    expect(ownMs({ box: 2, mac: null, run: 45 })).toBeNull()
  })

  it('prints one line per kind with the link beside it', () => {
    const v = judgeBridgeTiming(all(ten(20)), 'gate')
    const table = timingTable(v, { roundTripMs: 0.4, uploadMbps: 812.3 })
    expect(table.split('\n')).toHaveLength(5)
    expect(table).toMatch(/^observe\s+10\s+20\/20/m)
    expect(table).toContain('round trip 0 ms, upload 812.3 Mbit/s')
  })
})

const TIMING_LINES_MISSING = ['observe', 'observe-shot', 'set-value'].map((k) => `${k}: no timing lines from the box to split the legs`)
