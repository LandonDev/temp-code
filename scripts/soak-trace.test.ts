import { describe, expect, it } from 'vitest'
import { summarizeTrace, traceMarkdown, type TraceEvent } from './lib/soakTrace'

const meta = (pid: number, tid: number, name: string): TraceEvent => ({ name: 'thread_name', ph: 'M', pid, tid, ts: 0, args: { name } })
const x = (name: string, ts: number, dur: number, args?: Record<string, unknown>, tid = 1, pid = 10): TraceEvent => ({ name, ph: 'X', pid, tid, ts, dur, tdur: dur, args })
const call = (fn: string, ts: number, dur: number): TraceEvent => x('FunctionCall', ts, dur, { data: { functionName: fn, url: 'tempcode-app://renderer/assets/index-abc.js', lineNumber: 12 } })

/** One second: two frames, one with a rAF callback and a style update, one holding nothing. */
const trace: TraceEvent[] = [
  meta(10, 1, 'CrRendererMain'),
  meta(10, 2, 'Compositor'),
  meta(20, 1, 'CrRendererMain'),
  x('ProxyMain::BeginMainFrame', 1_000, 4_000),
  x('FireAnimationFrame', 1_100, 2_000),
  call('flush', 1_200, 1_500),
  call('inner', 1_300, 500),
  x('UpdateLayoutTree', 3_200, 500),
  x('ProxyMain::BeginMainFrame', 500_000, 1_000),
  x('TimerFire', 600_000, 300),
  call('tick', 600_050, 200),
  x('Compositor work', 700_000, 2_000, undefined, 2),
  x('ThreadControllerImpl::RunTask', 1_000_000, 10, undefined, 2),
  // another renderer with no frames is not the soak's window
  x('ProxyMain::BeginMainFrame', 2_000, 1_000, undefined, 1, 20),
  { name: 'Animation', ph: 'b', pid: 10, tid: 1, ts: 900, id2: { local: '0x1' }, args: { data: { displayName: 'spin', nodeName: "SPAN class='s'" } } },
  { name: 'Animation', ph: 'n', pid: 10, tid: 1, ts: 950, id2: { local: '0x1' }, args: { data: { compositeFailed: 0 } } },
  { name: 'Animation', ph: 'b', pid: 10, tid: 1, ts: 960, id2: { local: '0x2' }, args: { data: { displayName: '', nodeName: 'DIV' } } },
  { name: 'Animation', ph: 'n', pid: 10, tid: 1, ts: 970, id2: { local: '0x2' }, args: { data: { compositeFailed: 131104 } } }
]

describe('summarizeTrace', () => {
  const s = summarizeTrace(trace)

  it("reads the renderer whose main thread ran the most frames", () => {
    // Renderer 20 has one frame too, but renderer 10 has two.
    expect(s.rendererPid).toBe(10)
    expect(s.mainTid).toBe(1)
  })

  it('tells frames apart by what they held', () => {
    expect(s.frames).toEqual({ total: 2, raf: 1, style: 1, layout: 0, paint: 0, idle: 1 })
  })

  it('names callbacks by their outermost function', () => {
    expect(s.rafCallbacks).toEqual([['flush index-abc.js:12', { count: 1, ms: 1.5 }]])
    expect(s.timerCallbacks).toEqual([['tick index-abc.js:12', { count: 1, ms: 0.2 }]])
  })

  it('states busy time a second per thread, outermost slices only', () => {
    const threads = Object.fromEntries(s.threads)
    // CrRendererMain: frames 4 + 1 ms and the timer 0.3 ms over a 1.0 s window.
    expect(threads.CrRendererMain).toBe(5.3)
    expect(threads.Compositor).toBe(2)
  })

  it('joins each animation to its target and its compositing verdict', () => {
    expect(s.animations).toEqual([
      ['(web animation) DIV', { '131104': 1 }],
      ["spin SPAN class='s'", { '0': 1 }]
    ])
  })

  it('writes a report', () => {
    expect(traceMarkdown(s)[2]).toMatch(/^Main-thread frames: 2\.0 a second/)
  })
})
