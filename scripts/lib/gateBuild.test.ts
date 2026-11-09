import { describe, expect, it } from 'vitest'
import { DONE_POLL_MS, GATE_BUILD_WAIT_MS, STAMP_POLL_MS, waitForGateBuild, type GateBuildOptions } from './gateBuild'

const HEAD = 'a'.repeat(40)

/** A clock that moves only when the wait sleeps, and records each sleep. */
function rig(over: Partial<GateBuildOptions> = {}): { opts: GateBuildOptions; sleeps: number[]; built: number[] } {
  let t = 0
  const sleeps: number[] = []
  const built: number[] = []
  return {
    sleeps,
    built,
    opts: {
      tree: '/tree',
      doneFile: '',
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
      exists: () => false,
      readStamp: () => null,
      headState: () => ({ head: HEAD, clean: true }),
      ...over
    }
  }
}

describe('waitForGateBuild', () => {
  it('waits for the done file and returns once it appears', async () => {
    let calls = 0
    const { opts, sleeps } = rig({ doneFile: '/gate/build.done', exists: (p) => p === '/gate/build.done' && ++calls > 3 })
    expect(await waitForGateBuild(opts)).toBe('done-file')
    expect(sleeps).toEqual([DONE_POLL_MS, DONE_POLL_MS, DONE_POLL_MS])
  })

  it('returns at once on a current stamp', async () => {
    const { opts, sleeps } = rig({ readStamp: () => ({ sha: HEAD, clean: true }) })
    expect(await waitForGateBuild(opts)).toBe('current')
    expect(sleeps).toEqual([])
  })

  it("ignores last run's valid stamp at the same HEAD while the done file is absent", async () => {
    const { opts } = rig({ doneFile: '/gate/build.done', readStamp: () => ({ sha: HEAD, clean: true }), timeoutMs: 5_000 })
    await expect(waitForGateBuild(opts)).rejects.toThrow(/never finished/)
  })

  it('polls a stale stamp and times out, never building', async () => {
    const { opts, sleeps, built } = rig({ readStamp: () => ({ sha: 'b'.repeat(40), clean: true }) })
    await expect(waitForGateBuild(opts)).rejects.toThrow(/not HEAD's build .* after 10 minutes/)
    expect(built).toEqual([])
    expect(sleeps.every((ms) => ms === STAMP_POLL_MS)).toBe(true)
    expect(sleeps.length).toBe(GATE_BUILD_WAIT_MS / STAMP_POLL_MS + 1)
  })

  it('takes a stamp that turns current while it polls', async () => {
    let reads = 0
    const { opts } = rig({ readStamp: () => (++reads > 2 ? { sha: HEAD, clean: true } : null) })
    expect(await waitForGateBuild(opts)).toBe('current')
  })

  it('reads a dirty tree as stale whatever the stamp says', async () => {
    const { opts } = rig({ readStamp: () => ({ sha: HEAD, clean: true }), headState: () => ({ head: HEAD, clean: false }), timeoutMs: 4_000 })
    await expect(waitForGateBuild(opts)).rejects.toThrow(/HEAD aaaaaaaa dirty/)
  })

  it("runs the soak's own build once when told to, and only with no done file", async () => {
    const r = rig()
    let builds = 0
    expect(await waitForGateBuild({ ...r.opts, orBuild: () => void builds++ })).toBe('built')
    expect(builds).toBe(1)
    let called = 0
    const withDone = rig({ doneFile: '/gate/build.done', exists: () => true })
    expect(await waitForGateBuild({ ...withDone.opts, orBuild: () => void called++ })).toBe('done-file')
    expect(called).toBe(0)
  })
})
