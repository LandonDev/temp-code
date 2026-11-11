import { describe, expect, it } from 'vitest'
import { keepFrontAfterLaunch, restoreFront, settleFront } from './settleFront'

/** A fake clock the sleeps advance, and a front that follows a script of pids, one per read. */
function rig(fronts: number[]) {
  let t = 0
  let reads = 0
  const restored: number[] = []
  return {
    restored,
    deps: {
      frontPid: () => fronts[Math.min(reads++, fronts.length - 1)],
      restore: () => restored.push(t),
      sleep: async (ms: number) => {
        t += ms
      },
      now: () => t,
      ms: 500,
      everyMs: 100
    }
  }
}

describe('settleFront', () => {
  it('puts the person back each time the scratch app takes the front, and counts the steals', async () => {
    const r = rig([1, 7, 1, 1, 7])
    expect(await settleFront(7, r.deps)).toBe(2)
    expect(r.restored).toEqual([100, 400])
  })

  it('leaves the front alone when the scratch app never takes it, and watches for the whole span', async () => {
    const r = rig([1])
    expect(await settleFront(7, r.deps)).toBe(0)
    expect(r.restored).toEqual([])
    let reads = 0
    await settleFront(7, { ...r.deps, frontPid: () => (reads++, 1) })
    expect(reads).toBe(5)
  })
})

describe('keepFrontAfterLaunch', () => {
  it('puts the person back at once when the launch has the front, then watches the span', async () => {
    const r = rig([7, 1, 1, 7, 1, 1, 1, 1])
    expect(await keepFrontAfterLaunch(7, r.deps)).toEqual({ front: 'bounced', steals: 2 })
    expect(r.restored).toEqual([0, 200])
  })

  it('kept when the app never came forward, took when it holds the front at the end', async () => {
    expect(await keepFrontAfterLaunch(7, rig([1]).deps)).toEqual({ front: 'kept', steals: 0 })
    expect((await keepFrontAfterLaunch(7, rig([7]).deps)).front).toBe('took')
  })
})

describe('restoreFront', () => {
  it('restores the saved window by pid, else the app alone, else says it is gone', () => {
    const calls: [number, number][] = []
    expect(restoreFront((p, w) => void calls.push([p, w]), { pid: 5, window: 9 })).toBe('window')
    expect(restoreFront((p, w) => { calls.push([p, w]); if (w) throw new Error('window gone') }, { pid: 5, window: 9 })).toBe('app')
    expect(restoreFront(() => { throw new Error('app gone') }, { pid: 5, window: 9 })).toBe('gone')
    expect(calls).toEqual([[5, 9], [5, 9], [5, 0]])
  })
})
