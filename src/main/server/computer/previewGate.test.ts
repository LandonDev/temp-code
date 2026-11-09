import { describe, expect, it } from 'vitest'
import { PreviewGate, PREVIEW_STARVE_MS } from './previewGate'

describe('PreviewGate', () => {
  it('keeps one draw and the newest pending frame for each watcher', () => {
    const a: number[] = [],
      b: number[] = [],
      service: number[] = []
    const gate = new PreviewGate<{ seq: number }>(
      () => 0,
      (seq) => service.push(seq)
    )
    gate.add('a', (f) => a.push(f.seq))
    gate.add('b', (f) => b.push(f.seq))
    for (let seq = 1; seq <= 4; seq++) gate.frame({ seq })
    expect(a).toEqual([1])
    expect(b).toEqual([1])
    expect(service).toEqual([1, 2, 3, 4])
    gate.ack('a', 2)
    expect(a).toEqual([1])
    gate.ack('a', 1)
    expect(a).toEqual([1, 4])
    expect(b).toEqual([1])
    gate.ack('b', 1)
    expect(b).toEqual([1, 4])
  })
  it('stops service acks after all watchers starve and resumes on a valid draw ack', () => {
    let now = 0
    const service: number[] = []
    const gate = new PreviewGate<{ seq: number }>(
      () => now,
      (seq) => service.push(seq)
    )
    gate.add('a', () => {})
    gate.add('b', () => {})
    gate.frame({ seq: 1 })
    now = 4000
    gate.ack('b', 1)
    now = PREVIEW_STARVE_MS
    gate.frame({ seq: 2 })
    expect(service).toEqual([1, 2])
    now = 9000
    gate.frame({ seq: 3 })
    gate.frame({ seq: 4 })
    expect(service).toEqual([1, 2])
    gate.ack('b', 99)
    expect(service).toEqual([1, 2])
    gate.ack('b', 2)
    expect(service).toEqual([1, 2, 3, 4])
    gate.frame({ seq: 5 })
    expect(service).toEqual([1, 2, 3, 4, 5])
  })
  it('gives a joining watcher a draw that can wake a starved service', () => {
    let now = 0
    const service: number[] = [],
      draws: number[] = []
    const gate = new PreviewGate<{ seq: number }>(
      () => now,
      (seq) => service.push(seq)
    )
    gate.add('quiet', () => {})
    gate.frame({ seq: 1 })
    now = PREVIEW_STARVE_MS
    gate.frame({ seq: 2 })
    gate.frame({ seq: 3 })
    gate.add('new', (f) => draws.push(f.seq))
    expect(draws).toEqual([3])
    gate.ack('new', 3)
    expect(service).toEqual([1, 2, 3])
    gate.frame({ seq: 4 })
    expect(draws).toEqual([3, 4])
  })
  it('acks discarded frames and ignores draws from an old stream', () => {
    const service: number[] = []
    const gate = new PreviewGate<{ seq: number }>(
      () => 0,
      (seq) => service.push(seq)
    )
    gate.frame({ seq: 1 })
    expect(service).toEqual([1])
    gate.add('a', () => {})
    gate.frame({ seq: 2 })
    gate.reset()
    gate.frame({ seq: 3 })
    gate.ack('a', 2)
    gate.remove('a')
    gate.frame({ seq: 4 })
    expect(service).toEqual([1, 2, 3, 4])
  })
})
