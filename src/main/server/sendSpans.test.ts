import { describe, expect, it } from 'vitest'
import { formatSpan, SEND_SPAN_DEADLINE_MS, SendSpans } from './sendSpans'

function rig() {
  let clock = 1_000
  const lines: string[] = []
  const timers: { fn: () => void; due: number; cleared: boolean }[] = []
  const spans = new SendSpans({
    write: (line) => lines.push(line),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, due: clock + ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    }
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const t of timers) {
      if (!t.cleared && t.due <= clock) {
        t.cleared = true
        t.fn()
      }
    }
  }
  return { spans, lines, advance, timers }
}

describe('SendSpans', () => {
  it('a complete span is one line with every phase in order, ms from accepted', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(12)
    spans.mark('s1', 'prepared')
    advance(328)
    spans.mark('s1', 'handle', 'warm')
    advance(15)
    spans.mark('s1', 'delivered')
    advance(545)
    spans.mark('s1', 'init')
    advance(300)
    spans.mark('s1', 'first-message')
    advance(900)
    spans.mark('s1', 'first-content')
    expect(lines).toEqual(['send session=s1 accepted=0 prepared=12 handle=340(warm) delivered=355 init=900 first-message=1200 first-content=2100'])
    expect(spans.open()).toEqual([])
    // Marks after the flush say nothing.
    spans.mark('s1', 'first-content')
    expect(lines).toHaveLength(1)
  })

  it('a stalled span flushes at the deadline naming the phases missing', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(40)
    spans.mark('s1', 'handle', 'cold')
    spans.mark('s1', 'prepared')
    advance(SEND_SPAN_DEADLINE_MS - 41)
    expect(lines).toEqual([])
    advance(1)
    expect(lines).toEqual(['send session=s1 accepted=0 prepared=40 handle=40(cold) delivered=- init=- first-message=- first-content=-'])
  })

  it('two sends on one session never share a span: the second begin flushes the first', () => {
    const { spans, lines, advance, timers } = rig()
    spans.begin('s1')
    advance(100)
    spans.mark('s1', 'delivered')
    spans.begin('s1')
    expect(lines).toEqual(['send session=s1 accepted=0 prepared=- handle=- delivered=100 init=- first-message=- first-content=-'])
    expect(timers[0].cleared).toBe(true)
    advance(50)
    spans.mark('s1', 'first-content')
    expect(lines[1]).toBe('send session=s1 accepted=0 prepared=- handle=- delivered=- init=- first-message=- first-content=50')
  })

  it('a dropped span writes nothing and clears its timer; a mark with no span is ignored', () => {
    const { spans, lines, advance, timers } = rig()
    spans.begin('s1')
    spans.drop('s1')
    expect(timers[0].cleared).toBe(true)
    advance(SEND_SPAN_DEADLINE_MS + 1)
    spans.mark('s2', 'init')
    expect(lines).toEqual([])
  })

  it('the first mark of a phase keeps its time; a later note is taken', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(10)
    spans.mark('s1', 'handle')
    advance(10)
    spans.mark('s1', 'handle', 'live')
    spans.mark('s1', 'first-content')
    expect(lines[0]).toContain('handle=10(live)')
  })

  it('formatSpan rounds and tags', () => {
    expect(formatSpan('x', { accepted: 0, prepared: 1.6 }, { prepared: 'n' })).toBe('send session=x accepted=0 prepared=2(n) handle=- delivered=- init=- first-message=- first-content=-')
  })
})
