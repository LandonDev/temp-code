import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HeadTailOutput,
  ProgressOrder,
  ProgressPacer,
  droppedMarker,
  utf8SafeEnd,
  utf8SafeStart
} from './peerStreams'

afterEach(() => vi.useRealTimers())

const b = (s: string): Buffer => Buffer.from(s)

describe('utf8 boundaries', () => {
  it('trims an incomplete sequence at the end and skips continuation bytes at the start', () => {
    const euro = b('€') // e2 82 ac
    expect(utf8SafeEnd(Buffer.concat([b('ab'), euro]))).toBe(5)
    expect(utf8SafeEnd(Buffer.concat([b('ab'), euro.subarray(0, 2)]))).toBe(2)
    expect(utf8SafeEnd(Buffer.concat([b('ab'), euro.subarray(0, 1)]))).toBe(2)
    expect(utf8SafeEnd(b('😀'))).toBe(4)
    expect(utf8SafeEnd(b('😀').subarray(0, 3))).toBe(0)
    expect(utf8SafeStart(Buffer.concat([euro.subarray(1), b('x')]))).toBe(2)
    expect(utf8SafeStart(b('abc'), 1)).toBe(1)
  })
})

describe('HeadTailOutput', () => {
  it('keeps everything under the cap, per stream, in order', () => {
    const o = new HeadTailOutput(8, 24)
    o.push('stdout', b('one\n'))
    o.push('stderr', b('err\n'))
    o.push('stdout', b('two\n'))
    expect(o.text('stdout')).toBe('one\ntwo\n')
    expect(o.text('stderr')).toBe('err\n')
    expect(o.truncated).toBe(false)
    expect(o.total).toBe(12)
  })

  it('past the cap keeps the first head and the last tail bytes, with a marker counting the middle', () => {
    const o = new HeadTailOutput(10, 20)
    const all = Array.from({ length: 50 }, (_, i) => `${i}`.padStart(3, '0') + '\n').join('')
    for (let i = 0; i < all.length; i += 7) o.push('stdout', b(all.slice(i, i + 7)))
    expect(o.truncated).toBe(true)
    expect(o.total).toBe(all.length)
    expect(o.dropped).toBe(all.length - 30)
    expect(o.kept).toBe(30)
    const text = o.text('stdout')
    const marker = droppedMarker('stdout', all.length - 30, 10, 20)
    expect(text).toBe(all.slice(0, 10) + marker + all.slice(-20))
    expect(marker).toMatch(/170 bytes of stdout dropped here/)
  })

  it('at the real sizes: 1 MiB head, 3 MiB tail, the marker in MiB', () => {
    const o = new HeadTailOutput()
    const line = 'x'.repeat(1023) + '\n'
    for (let i = 0; i < 6 * 1024; i++) o.push('stdout', b(line))
    expect(o.kept).toBe(4 * 1024 * 1024)
    expect(o.dropped).toBe(2 * 1024 * 1024)
    const text = o.text('stdout')
    expect(text).toContain(
      `[mac_run: ${2 * 1024 * 1024} bytes of stdout dropped here; the output passed 4 MiB, so the first 1 MiB and the last 3 MiB are kept]`
    )
    expect(text.startsWith(line)).toBe(true)
    expect(text.endsWith(line)).toBe(true)
  })

  it('counts drops per stream: a stream that lost nothing has no marker', () => {
    const o = new HeadTailOutput(4, 8)
    o.push('stderr', b('E1\n'))
    o.push('stdout', b('aaaaaaaaaa'))
    o.push('stdout', b('bbbbbbbbbb'))
    o.push('stderr', b('E2\n'))
    expect(o.text('stderr')).toBe('E1\nE2\n')
    expect(o.text('stdout')).toContain('bytes of stdout dropped')
  })

  it('never splits a character at the cut', () => {
    const o = new HeadTailOutput(4, 4)
    o.push('stdout', b('ab€cd€€€'))
    const text = o.text('stdout')
    expect(text).not.toContain('\ufffd')
    expect(text.startsWith('ab')).toBe(true)
    expect(text.endsWith('€')).toBe(true)
  })

  it('stays O(1) per piece with many tiny pieces', () => {
    const o = new HeadTailOutput(16, 64)
    for (let i = 0; i < 200_000; i++) o.push('stdout', b('x'))
    expect(o.kept).toBe(80)
    expect(o.dropped).toBe(200_000 - 80)
  })
})

describe('ProgressPacer', () => {
  type Sent = { at: number; chunk: string; skipped: number }
  const pacer = (
    opts: { frameBytes?: number; intervalMs?: number; partialLineMs?: number } = {}
  ): { p: ProgressPacer; frames: Sent[] } => {
    const frames: Sent[] = []
    const p = new ProgressPacer({
      send: (chunk, skipped) => frames.push({ at: Date.now(), chunk, skipped }),
      ...opts
    })
    return { p, frames }
  }

  it('sends whole lines, at most one frame per 100 ms', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer()
    const start = Date.now()
    for (let i = 0; i < 40; i++) {
      p.push('stdout', b(`line ${i}\n`))
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(200)
    expect(frames.length).toBeGreaterThanOrEqual(4)
    expect(frames.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < frames.length; i++)
      expect(frames[i].at - frames[i - 1].at).toBeGreaterThanOrEqual(100)
    expect(frames[0].at - start).toBeLessThan(10)
    expect(frames.map((f) => f.chunk).join('')).toBe(
      Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('')
    )
    for (const f of frames) expect(f.chunk.endsWith('\n')).toBe(true)
  })

  it('holds a line until its newline; stdout and stderr never mix inside a line', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer()
    p.push('stdout', b('out-a'))
    p.push('stderr', b('err-a'))
    vi.advanceTimersByTime(150)
    expect(frames).toEqual([])
    p.push('stderr', b('\n'))
    p.push('stdout', b('\n'))
    vi.advanceTimersByTime(1)
    expect(frames.map((f) => f.chunk).join('')).toBe('err-a\nout-a\n')
  })

  it('a line with no newline goes out once it has waited (a prompt)', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer({ partialLineMs: 1_000 })
    p.push('stdout', b('Password: '))
    vi.advanceTimersByTime(900)
    expect(frames).toEqual([])
    vi.advanceTimersByTime(200)
    expect(frames.map((f) => f.chunk)).toEqual(['Password: '])
  })

  it('a frame carries at most 64 KiB: a backlog keeps its newest lines and counts the rest skipped', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer()
    p.push('stdout', b('first\n'))
    vi.advanceTimersByTime(1)
    const line = 'y'.repeat(99) + '\n'
    for (let i = 0; i < 3_000; i++) p.push('stdout', b(line)) // 300 KB inside one window
    vi.advanceTimersByTime(150)
    expect(frames.length).toBe(2)
    expect(Buffer.byteLength(frames[1].chunk)).toBeLessThanOrEqual(64 * 1024)
    expect(frames[1].chunk.startsWith('y')).toBe(true)
    expect(frames[1].skipped + Buffer.byteLength(frames[1].chunk)).toBe(300_000)
  })

  it('a line longer than a frame is cut on a character', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer({ frameBytes: 10 })
    p.push('stdout', b('€€€€€€€€'))
    vi.advanceTimersByTime(500)
    p.end()
    for (const f of frames) {
      expect(f.chunk).not.toContain('\ufffd')
      expect(Buffer.byteLength(f.chunk)).toBeLessThanOrEqual(10)
    }
    const sent = frames.reduce((n, f) => n + f.skipped + Buffer.byteLength(f.chunk), 0)
    expect(sent).toBe(Buffer.byteLength('€€€€€€€€'))
  })

  it('end() sends what is left at once, partial lines too, and nothing after', () => {
    vi.useFakeTimers()
    const { p, frames } = pacer()
    p.push('stdout', b('a\n'))
    vi.advanceTimersByTime(1)
    p.push('stdout', b('b\nno newline'))
    p.end()
    expect(frames.map((f) => f.chunk)).toEqual(['a\n', 'b\nno newline'])
    p.push('stdout', b('late\n'))
    vi.advanceTimersByTime(500)
    expect(frames.length).toBe(2)
    expect(p.frames).toBe(2)
  })
})

describe('ProgressOrder', () => {
  it('delivers in seq order and gives up on a gap that never fills', () => {
    const got: number[] = []
    const o = new ProgressOrder((f) => got.push(f.seq), 3)
    o.take({ seq: 0, chunk: '', skipped: 0 })
    o.take({ seq: 2, chunk: '', skipped: 0 })
    o.take({ seq: 3, chunk: '', skipped: 0 })
    o.take({ seq: 4, chunk: '', skipped: 0 })
    expect(got).toEqual([0])
    o.take({ seq: 5, chunk: '', skipped: 0 })
    expect(got).toEqual([0, 2, 3, 4, 5])
    o.take({ seq: 1, chunk: '', skipped: 0 })
    expect(got).toEqual([0, 2, 3, 4, 5])
  })
})
