import { describe, expect, it } from 'vitest'
import { coveredFraction, windowCoverage, type CoverWindow } from './windowCover'
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
