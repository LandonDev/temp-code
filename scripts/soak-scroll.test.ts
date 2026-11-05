import { describe, expect, it } from 'vitest'
import { displayInterval, scrollMarkdown, summarizeFrames, wheelPlan, type FrameRun, type ScrollResult } from './lib/soakScroll'

const run = (intervals: number[], over: Partial<FrameRun> = {}): FrameRun => ({ intervals, ms: intervals.reduce((a, b) => a + b, 0), scrolledPx: 2400, longTasks: [], frames: [], ...over })

describe('the wheel', () => {
  it('ticks at its rate for its length, turning back at either end of the range', () => {
    const ticks = wheelPlan(1000, 60, 40, 200, 0)
    expect(ticks).toHaveLength(60)
    expect(ticks[1]!.at).toBe(17)
    // Down from the top: five ticks reach the end, then it turns.
    expect(ticks.slice(0, 7).map((t) => t.deltaY)).toEqual([40, 40, 40, 40, 40, -40, -40])
    let at = 0
    for (const t of ticks) {
      at += t.deltaY
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThanOrEqual(200)
    }
  })

  it('goes up first from the bottom (a transcript following its end), and nowhere on a list too short to scroll', () => {
    expect(wheelPlan(100, 60, 40, 5000, 5000)[0]!.deltaY).toBe(-40)
    expect(wheelPlan(100, 60, 40, 5000, 2000)[0]!.deltaY).toBe(40)
    expect(wheelPlan(1000, 60, 40, 30, 0)).toEqual([])
  })
})

describe('the frames', () => {
  it('reads the display from an idle run, and counts the frames it missed and the slow ones', () => {
    const display = displayInterval([16.6, 16.7, 16.8, 16.7, 33.4])
    expect(display).toBe(16.7)
    const s = summarizeFrames(run([16.7, 16.7, 33.4, 16.7, 50.1, 16.7]), display)
    expect(s).toMatchObject({ frames: 6, dropped: 3, longestMs: 50.1, over32: 2, scrolledPx: 2400 })
    expect(s.fps).toBeCloseTo(6 / 0.1503, 0)
    expect(summarizeFrames(run([16.7], { longTasks: [{ start: 0, duration: 64.4 }] }), display).longTasks).toEqual({ count: 1, maxMs: 64 })
  })

  it('writes a row per surface and mode, and says why a surface did not scroll', () => {
    const results: ScrollResult[] = [
      { surface: 'transcript', mode: 'wheel', summary: summarizeFrames(run([16.7, 16.7]), 16.7), skipped: null, frames: [{ duration: 64, scripts: ['onScroll 40 ms'] }] },
      { surface: 'rail', mode: 'wheel', summary: null, skipped: 'does not overflow', frames: [] }
    ]
    const md = scrollMarkdown(results, 16.7).join('\n')
    expect(md).toContain('every 16.7 ms (60 Hz)')
    expect(md).toContain('| transcript | wheel | 59.9 | 0 | 16.7 | 0 |')
    expect(md).toContain('64 ms: onScroll 40 ms')
    expect(md).toContain('| rail | wheel | – | – | – | – | – | – | – | does not overflow |')
  })
})
