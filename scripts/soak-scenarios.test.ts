import { afterEach, describe, expect, it, vi } from 'vitest'
import { playScenarios, scenarioLength, scenarioTimeline } from './lib/soakScenarios'

afterEach(() => vi.useRealTimers())

describe('the no-jerk scenarios timeline', () => {
  it("names each step, keeps them in time order, and covers the plan's scenarios", () => {
    const steps = scenarioTimeline()
    expect(steps.every((s, i) => i === 0 || s.at >= steps[i - 1]!.at)).toBe(true)
    const labels = steps.map((s) => s.label).join('\n')
    for (const want of ["the host's wait", 'the group opens', '(fast)', 'a long command', 'every 100 ms', 'steers', 'compaction starts', 'paused', 'resumed', 'stopped', 'a burst lands whole', 'ends 30 ms later']) {
      expect(labels).toContain(want)
    }
    const burst = steps.findIndex((s) => s.label.includes('a burst lands whole'))
    expect(steps[burst + 1]!.at - steps[burst]!.at).toBe(30)
    expect(scenarioLength(steps)).toBe(steps[steps.length - 1]!.at)
  })

  it("appends each step's events at its time, in order", () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const steps = [
      { at: 0, label: 'a', events: [{ type: 'turn-complete' as const }] },
      { at: 100, label: 'b', events: [{ type: 'status' as const, status: 'idle' as const }] },
      { at: 200, label: 'c', events: [], resume: true as const },
    ]
    playScenarios((e) => seen.push(e.type), (s) => seen.push(s.label), steps, () => seen.push('resume'))
    vi.advanceTimersByTime(50)
    expect(seen).toEqual(['a', 'turn-complete'])
    vi.advanceTimersByTime(60)
    expect(seen).toEqual(['a', 'turn-complete', 'b', 'status'])
    vi.advanceTimersByTime(100)
    expect(seen).toEqual(['a', 'turn-complete', 'b', 'status', 'c', 'resume'])
  })
})
