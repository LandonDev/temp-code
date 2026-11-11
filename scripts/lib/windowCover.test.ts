import { describe, expect, it } from 'vitest'
import { coveredFraction, windowCoverage, type CoverWindow, coverWord, probeCover } from './windowCover'
const rect = { x: 10, y: 10, w: 100, h: 100 }
const win = (pid: number, extra: Partial<CoverWindow> = {}): CoverWindow => ({
  ...rect,
  pid,
  id: pid,
  layer: 0,
  alpha: 1,
  ...extra
})
describe('window coverage', () => {
  it('clips to the target and takes the union, without counting overlap twice', () => {
    expect(coveredFraction(rect, [])).toBe(0)
    expect(coveredFraction(rect, [{ x: 0, y: 0, w: 100, h: 100 }])).toBe(0.81)
    expect(
      coveredFraction(rect, [
        { ...rect, w: 60 },
        { ...rect, x: 50, w: 60 }
      ])
    ).toBe(1)
    expect(coveredFraction(rect, [rect, rect])).toBe(1)
    expect(coveredFraction(rect, [{ ...rect, x: 110 }])).toBe(0)
    expect(coveredFraction({ ...rect, w: 0 }, [rect])).toBe(0)
    expect(
      coveredFraction(rect, [
        { ...rect, x: NaN },
        { ...rect, w: -1 }
      ])
    ).toBe(0)
  })
  it('uses only opaque normal windows in front and keeps partial cover distinct', () => {
    expect(windowCoverage([win(2), win(1)], 1)).toEqual({ window: 1, covered: true, fraction: 1 })
    expect(windowCoverage([win(1), win(2)], 1)).toEqual({ window: 1, covered: false, fraction: 0 })
    expect(windowCoverage([win(2, { alpha: 0.5 }), win(3, { layer: 3 }), win(1)], 1)?.covered).toBe(
      false
    )
    expect(windowCoverage([win(2, { w: 50 }), win(1)], 1)).toMatchObject({
      covered: false,
      fraction: 0.5
    })
    expect(windowCoverage([win(1)], 9)).toBeNull()
    expect(windowCoverage([win(1), win(1, { id: 7 })], 1, 7)).toMatchObject({
      window: 7,
      covered: true
    })
  })
})

describe('probeCover', () => {
  const w = (id: number, pid: number, layer: number, x: number, y: number, ww: number, h: number, alpha = 1) => ({ id, pid, layer, alpha, x, y, w: ww, h })
  // TC Probe floats (layer 3) over the person's full-screen window (layer 0), 2026-11-11
  const person = w(38644, 4416, 0, 0, 30, 3200, 1696)
  const probe = w(42138, 92853, 3, 160, 1490, 360, 150)

  it('reads a floating probe over the person’s window as uncovered', () => {
    const cover = probeCover([probe, person], 92853)
    expect(cover).toEqual({ window: 42138, layer: 3, fraction: 0, by: [] })
    expect(coverWord(cover)).toBeNull()
  })

  it('names what covers it and fails the check as not judged', () => {
    const palette = w(5, 777, 3, 100, 1450, 200, 200)
    const cover = probeCover([palette, probe, person], 92853, 42138)
    expect(cover?.by).toEqual([777])
    expect(cover!.fraction).toBeGreaterThan(0)
    expect(coverWord(cover)).toMatch(/^not judged: covered, \d+% by pid 777$/)
    // a see-through window does not cover it
    expect(coverWord(probeCover([w(6, 777, 3, 100, 1450, 200, 200, 0.5), probe], 92853))).toBeNull()
  })

  it('says so when the probe is not on screen at all', () => {
    expect(probeCover([person], 92853)).toBeNull()
    expect(coverWord(null)).toBe('not judged: TC Probe is not on screen (another Space or a full-screen app)')
  })
})
