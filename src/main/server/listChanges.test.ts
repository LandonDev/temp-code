import { describe, expect, it } from 'vitest'
import { ListChangeLog } from './listChanges'

describe('ListChangeLog', () => {
  it('answers reset for an unknown generation and the current head', () => {
    const log = new ListChangeLog('g1')
    log.changed('a')
    const out = log.since(0, 'other')
    expect(out).toEqual({ reset: true, seq: 1, generation: 'g1' })
  })

  it('answers reset for a seq ahead of the log or a malformed one', () => {
    const log = new ListChangeLog('g1')
    log.changed('a')
    expect(log.since(5, 'g1').reset).toBe(true)
    expect(log.since(-1, 'g1').reset).toBe(true)
    expect(log.since(1.5, 'g1').reset).toBe(true)
  })

  it('lists each id once in its newest state, removals superseding changes', () => {
    const log = new ListChangeLog('g1')
    log.changed('a')
    log.changed('b')
    log.changed('a')
    log.removed(['b'])
    log.changed('c')
    const out = log.since(0, 'g1')
    expect(out).toEqual({ reset: false, seq: 5, generation: 'g1', changed: ['a', 'c'], removed: ['b'] })
  })

  it('answers only what followed afterSeq', () => {
    const log = new ListChangeLog('g1')
    log.changed('a') // 1
    log.changed('b') // 2
    log.changed('c') // 3
    const out = log.since(2, 'g1')
    expect(out.reset).toBe(false)
    if (!out.reset) expect(out.changed).toEqual(['c'])
    // A change to an id already listed re-stamps it: afterSeq 2 then sees a again.
    log.changed('a') // 4
    const again = log.since(2, 'g1')
    if (!again.reset) expect(again.changed).toEqual(['c', 'a'])
  })

  it('an empty log at seq 0 resumes from 0 with nothing', () => {
    const log = new ListChangeLog('g1')
    expect(log.since(0, 'g1')).toEqual({ reset: false, seq: 0, generation: 'g1', changed: [], removed: [] })
  })

  it('a resume at the head answers nothing', () => {
    const log = new ListChangeLog('g1')
    log.changed('a')
    log.changed('b')
    expect(log.since(2, 'g1')).toEqual({ reset: false, seq: 2, generation: 'g1', changed: [], removed: [] })
  })

  it('resets once the window no longer reaches afterSeq', () => {
    const log = new ListChangeLog('g1', 3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) log.changed(id) // seqs 1..5, window keeps 3,4,5
    expect(log.floor).toBe(2)
    expect(log.since(2, 'g1').reset).toBe(false) // 3,4,5 follow 2: still within reach
    expect(log.since(1, 'g1').reset).toBe(true) // seq 2 fell out
    const ok = log.since(2, 'g1')
    if (!ok.reset) expect(ok.changed).toEqual(['c', 'd', 'e'])
  })

  it('a re-stamped id keeps one slot so a chatty thread never evicts the window', () => {
    const log = new ListChangeLog('g1', 3)
    log.changed('a')
    log.changed('b')
    for (let i = 0; i < 50; i++) log.changed('c')
    const out = log.since(0, 'g1')
    expect(out.reset).toBe(false)
    if (!out.reset) expect(out.changed).toEqual(['a', 'b', 'c'])
  })
})
