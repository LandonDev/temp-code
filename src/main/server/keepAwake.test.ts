import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import {
  KEEP_AWAKE_SETTING,
  KeepAwake,
  LIVE_WORK_HEARTBEAT_MS,
  PEER_LIVE_TTL_MS,
  RELEASE_GRACE_MS,
  keepAwakeMode,
  shouldHoldAwake
} from './keepAwake'

const on = { mode: 'while-working' as const, onBattery: false }

describe('shouldHoldAwake', () => {
  it('holds while a thread here is live, and for the grace after the last one settles', () => {
    expect(shouldHoldAwake({ live: 1, lastLiveAt: 0 }, [], on, 0)).toBe(true)
    expect(shouldHoldAwake({ live: 0, lastLiveAt: 1000 }, [], on, 1000 + RELEASE_GRACE_MS - 1)).toBe(true)
    expect(shouldHoldAwake({ live: 0, lastLiveAt: 1000 }, [], on, 1000 + RELEASE_GRACE_MS)).toBe(false)
    expect(shouldHoldAwake({ live: 0, lastLiveAt: null }, [], on, 5)).toBe(false)
  })

  it('holds while a peer said live within the TTL, and not after', () => {
    const idle = { live: 0, lastLiveAt: null }
    expect(shouldHoldAwake(idle, [{ live: true, heardAt: 0 }], on, PEER_LIVE_TTL_MS - 1)).toBe(true)
    expect(shouldHoldAwake(idle, [{ live: true, heardAt: 0 }], on, PEER_LIVE_TTL_MS)).toBe(false)
    expect(shouldHoldAwake(idle, [{ live: false, heardAt: 0 }], on, 1)).toBe(false)
  })

  it('never holds under `never` or on battery', () => {
    expect(shouldHoldAwake({ live: 3, lastLiveAt: 0 }, [], { mode: 'never', onBattery: false }, 0)).toBe(false)
    expect(shouldHoldAwake({ live: 3, lastLiveAt: 0 }, [{ live: true, heardAt: 0 }], { mode: 'while-working', onBattery: true }, 0)).toBe(false)
  })

  it('reads an unset or unknown setting as while-working', () => {
    expect(keepAwakeMode(null)).toBe('while-working')
    expect(keepAwakeMode('junk')).toBe('while-working')
    expect(keepAwakeMode('never')).toBe('never')
  })
})

function rig(opts: { headless?: boolean } = {}) {
  let now = 0
  let live = 0
  let battery = false
  const settings = new Map<string, string>()
  const held: number[] = []
  const frames: ServerFrame[] = []
  const envs: string[] = []
  let powerListener: () => void = () => {}
  let next = 1
  const k = new KeepAwake({
    environmentId: 'me',
    liveCount: () => live,
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => (value === null ? settings.delete(key) : settings.set(key, value)),
    blocker: opts.headless
      ? undefined
      : {
          start: () => {
            held.push(next)
            return next++
          },
          stop: (id) => held.splice(held.indexOf(id), 1)
        },
    power: { onBattery: () => battery, onChange: (l) => (powerListener = l) },
    notify: (f) => frames.push(f),
    env: (mode) => envs.push(mode),
    now: () => now
  })
  return {
    k,
    held,
    frames,
    settings,
    envs,
    set: (p: { now?: number; live?: number; battery?: boolean }) => {
      if (p.now !== undefined) now = p.now
      if (p.live !== undefined) live = p.live
      if (p.battery !== undefined) {
        battery = p.battery
        powerListener()
      }
    }
  }
}

describe('KeepAwake', () => {
  it('takes one hold while threads are live and drops it after the grace', () => {
    const r = rig()
    r.set({ live: 2 })
    r.k.check()
    r.k.check()
    expect(r.held).toEqual([1])
    expect(r.k.status()).toEqual({ mode: 'while-working', supported: true, holding: true, onBattery: false })
    r.set({ live: 0, now: 10_000 })
    r.k.check()
    expect(r.held).toEqual([1])
    r.set({ now: RELEASE_GRACE_MS + 1 })
    r.k.check()
    expect(r.held).toEqual([])
    expect(r.envs.at(-1)).toBe('while-working')
  })

  it('follows a peer word, and drops it when the link goes down or the word goes stale', () => {
    const r = rig()
    expect(r.k.onPeerPush('box', { push: 'live-work', from: 'box', live: true })).toBe(true)
    expect(r.held).toHaveLength(1)
    r.k.peerDown('box')
    expect(r.held).toHaveLength(0)
    r.k.onPeerPush('box', { push: 'live-work', from: 'box', live: true })
    r.set({ now: PEER_LIVE_TTL_MS })
    r.k.check()
    expect(r.held).toHaveLength(0)
    expect(r.k.onPeerPush('box', { push: 'release-available', from: 'box', version: '1.0.1' })).toBe(false)
  })

  it('releases on battery and under never, and takes it again on AC', () => {
    const r = rig()
    r.set({ live: 1 })
    r.k.check()
    r.set({ battery: true })
    expect(r.held).toHaveLength(0)
    expect(r.k.status().onBattery).toBe(true)
    r.set({ battery: false })
    expect(r.held).toHaveLength(1)
    expect(r.k.setMode('never')).toMatchObject({ mode: 'never', holding: false })
    expect(r.settings.get(KEEP_AWAKE_SETTING)).toBe('never')
    expect(r.k.setMode('while-working').holding).toBe(true)
    expect(r.settings.has(KEEP_AWAKE_SETTING)).toBe(false)
  })

  it('tells its peers on a change and every heartbeat, at once to a new peer, and a headless host never holds', () => {
    const r = rig({ headless: true })
    r.k.check()
    expect(r.frames).toEqual([{ push: 'live-work', from: 'me', live: false }])
    r.set({ live: 1, now: 1000 })
    r.k.check()
    r.k.check()
    expect(r.frames).toHaveLength(2)
    expect(r.frames[1]).toMatchObject({ live: true })
    r.set({ now: 1000 + LIVE_WORK_HEARTBEAT_MS })
    r.k.check()
    expect(r.frames).toHaveLength(3)
    r.k.peerUp()
    expect(r.frames).toHaveLength(4)
    expect(r.k.status()).toMatchObject({ supported: false, holding: false })
    expect(r.envs).toEqual([])
  })

  it('stop() lets go of the hold', () => {
    const r = rig()
    r.set({ live: 1 })
    r.k.start()
    expect(r.held).toHaveLength(1)
    r.k.stop()
    expect(r.held).toHaveLength(0)
  })
})
