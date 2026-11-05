import { afterEach, describe, expect, it, vi } from 'vitest'
import { playScenarios, questionClicks, questionSteps, scenarioLength, scenarioTimeline } from './lib/soakScenarios'

afterEach(() => vi.useRealTimers())

describe('the no-jerk scenarios timeline', () => {
  it("names each step, keeps them in time order, and covers the plan's scenarios", () => {
    const steps = scenarioTimeline()
    expect(steps.every((s, i) => i === 0 || s.at >= steps[i - 1]!.at)).toBe(true)
    const labels = steps.map((s) => s.label).join('\n')
    for (const want of ["the host's wait", 'the group opens', '(fast)', 'a long command', 'every 100 ms', 'steers', 'compaction starts', 'paused', 'resumed', 'stopped', 'a burst lands whole', 'ends 30 ms later', 'a question arrives', 'pages with Next', 'the answer folds', 'lands in the table', 'four calls land at once', 'the fence streams', 'a list streams', 'a table streams']) {
      expect(labels).toContain(want)
    }
    const burst = steps.findIndex((s) => s.label.includes('a burst lands whole'))
    expect(steps[burst + 1]!.at - steps[burst]!.at).toBe(30)
    expect(scenarioLength(steps)).toBe(steps[steps.length - 1]!.at)
  })

  it('lands ten calls with their results, six one at a time and four in one push, then streams 40 code lines', () => {
    const steps = scenarioTimeline()
    const results = (label: string) => steps.filter((s) => s.label.includes(label)).map((s) => s.events.filter((e) => e.type === 'tool-result').length)
    expect(results('lands in the table')).toEqual([1, 1, 1, 1, 1, 1])
    expect(results('four calls land at once')).toEqual([4])
    const fence = steps.filter((s) => s.label === 'turn 6: the fence streams').flatMap((s) => s.events)
    const code = fence.map((e) => (e.type === 'assistant-text' ? e.text : '')).join('')
    expect(code.split('\n').filter(Boolean)).toHaveLength(40)
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

  it('the question card arrives, pages on the person\'s clicks, and the host\'s answer folds it', () => {
    const steps = questionSteps(1_000)
    const arrives = steps.find((s) => s.label.includes('a question arrives'))!
    expect(arrives.events.map((e) => e.type)).toEqual(['tool-call', 'question-request', 'status'])
    const ask = arrives.events[1] as { requestId: string; questions: unknown[]; callId?: string }
    expect(ask.questions).toHaveLength(2)
    expect(ask.callId).toBe('t5-ask')
    const next = steps.find((s) => s.label.includes('pages with Next'))!
    expect(next.events).toEqual([])
    expect(next.clicks).toEqual(['inbox', 'Next'])
    const folds = steps.find((s) => s.label.includes('the answer folds'))!
    expect(folds.events[0]).toEqual({ type: 'question-resolved', requestId: ask.requestId, answers: [['inbox'], ['Yes']] })
    expect(steps.every((s, i) => i === 0 || s.at >= steps[i - 1]!.at)).toBe(true)
    // The page script clicks inside the card alone, in order, a frame apart.
    const script = questionClicks(['inbox', 'Next'])
    expect(script).toContain('[data-slot="question-card"] button')
    expect(script).toContain('["inbox","Next"]')
    expect(script).toContain('requestAnimationFrame')
  })
})
