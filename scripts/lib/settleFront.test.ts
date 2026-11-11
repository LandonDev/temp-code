import { describe, expect, it } from 'vitest'
import { settleFront } from './settleFront'

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
