import { describe, expect, it } from 'vitest'
import { findJumps, heightLine, JUMP_PX, summarizeHeights, type HeightRecord } from './lib/heightReport'

const rec = (box: number, t: number, height: number, kind: HeightRecord['kind'] = 'table'): HeightRecord => ({ box, t, height, kind })

describe('the height report', () => {
  it('takes a box mounting for no jump, and a glide of small steps for none', () => {
    const glide = [rec(1, 0, 0), rec(1, 16, 64), rec(1, 32, 70), rec(1, 48, 81), rec(1, 64, 92), rec(1, 80, 96), rec(1, 96, 96)]
    expect(findJumps(glide)).toEqual([])
  })

  it('finds a step of JUMP_PX or more with the box still on both sides of it', () => {
    const records = [rec(1, 0, 64), rec(1, 100, 64), rec(1, 200, 64 + JUMP_PX), rec(1, 300, 64 + JUMP_PX)]
    expect(findJumps(records, [{ label: 'a row lands', t: 150 }])).toEqual([{ box: 1, kind: 'table', from: 64, to: 64 + JUMP_PX, t: 200, step: 'a row lands' }])
  })

  it('takes a large frame inside a glide for motion, not a jump', () => {
    // A burst's glide: the fastest frame moves 24px, with motion on both sides.
    const records = [rec(2, 0, 96), rec(2, 16, 104), rec(2, 32, 128), rec(2, 48, 140), rec(2, 64, 160), rec(2, 80, 160)]
    expect(findJumps(records)).toEqual([])
  })

  it('ignores a step under JUMP_PX and keeps boxes apart', () => {
    const records = [rec(1, 0, 20), rec(2, 0, 20), rec(1, 10, 35), rec(2, 20, 40), rec(2, 30, 40)]
    expect(findJumps(records).map((j) => j.box)).toEqual([2])
  })

  it('counts the jumps per step in one line', () => {
    const steps = [{ label: 'turn 5: the fence streams', t: 0 }]
    const summary = summarizeHeights([rec(3, 10, 40, 'code'), rec(3, 20, 40, 'code'), rec(3, 30, 60, 'code')], steps)
    expect(summary).toMatchObject({ boxes: 1, records: 3, perStep: { 'turn 5: the fence streams': 1 } })
    expect(heightLine(summary)).toBe('1 boxes, 3 height records, 1 jumps: turn 5: the fence streams 1')
  })
})
