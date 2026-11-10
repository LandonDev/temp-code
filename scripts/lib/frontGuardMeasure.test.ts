import { describe, expect, it } from 'vitest'
import { changedWindows, observeFront, reportTable } from './frontGuardMeasure'

describe('observeFront', () => {
  const person = 100
  it('sees nothing when the person stayed in front', () => {
    expect(observeFront([{ pid: person, at: 0 }], person, 10, 1_000)).toEqual({ raised: false, awayMs: 0, back: true })
    expect(observeFront([], person, 10, 1_000)).toEqual({ raised: false, awayMs: 0, back: true })
  })

  it('measures a steal put back, and two spells together', () => {
    const samples = [
      { pid: person, at: 0 },
      { pid: 7, at: 200 },
      { pid: person, at: 380 },
      { pid: 7, at: 900 },
      { pid: person, at: 960 }
    ]
    expect(observeFront(samples, person, 100, 2_000)).toEqual({ raised: true, awayMs: 240, back: true })
  })

  it('counts a steal left standing to the end', () => {
    expect(observeFront([{ pid: person, at: 0 }, { pid: 7, at: 500 }], person, 100, 1_500)).toEqual({ raised: true, awayMs: 1_000, back: false })
  })

  it('ignores what came before the case and after it', () => {
    const samples = [
      { pid: 7, at: 0 },
      { pid: person, at: 50 },
      { pid: 9, at: 5_000 }
    ]
    expect(observeFront(samples, person, 100, 1_000)).toEqual({ raised: false, awayMs: 0, back: true })
  })
})

describe('the report', () => {
  it('draws one row a case, a skipped one with its reason', () => {
    const table = reportTable([
      {
        app: 'TextEdit',
        action: 'open probe.txt',
        outcome: 'ran',
        answerMs: 640,
        front: { raised: true, restored: 'restored', ms: 120 },
        observed: { raised: true, awayMs: 130, back: true },
        pointerMoved: false,
        window: { id: 4, title: 'probe.txt' },
        changed: ['"Untitled" is now "Untitled — iCloud"']
      },
      { app: 'Google Chrome', action: 'launch', outcome: 'skipped', why: 'the person\'s Chrome is running' }
    ])
    expect(table.split('\n')).toEqual([
      '| App | Action | Outcome | Answer | Guard | Samples | Pointer | Window | Other windows |',
      '|---|---|---|---|---|---|---|---|---|',
      '| TextEdit | open probe.txt | ran | 640 ms | restored 120 ms | raised, away 130 ms | still | "probe.txt" | "Untitled" is now "Untitled — iCloud" |',
      "| Google Chrome | launch | skipped: the person's Chrome is running | | | | | | |"
    ])
  })

  it('names new windows and changed titles by id', () => {
    expect(changedWindows([{ id: 1, title: 'Untitled' }, { id: 2, title: 'a.txt' }], [{ id: 1, title: 'Untitled — iCloud' }, { id: 2, title: 'a.txt' }, { id: 3, title: 'b.txt' }])).toEqual([
      '"Untitled" is now "Untitled — iCloud"',
      'new "b.txt"'
    ])
  })
})
