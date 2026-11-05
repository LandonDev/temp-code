import { describe, expect, it, vi } from 'vitest'
import { AwayService } from '../away'
import { AwaySync } from './awaySync'

const settings = () => {
  const rows = new Map<string, string>()
  return {
    getSetting: (k: string) => rows.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? rows.delete(k) : rows.set(k, v))
  }
}

/** A host: its service, and its clock. */
const host = (environmentId: string, clock: { t: number }) =>
  new AwayService({ ...settings(), environmentId, now: () => clock.t })

/**
 * A Mac's link to the box: requests run the box's RPCs, and the box's push
 * to every socket reaches the Mac's sync while the link is up.
 */
const link = (box: AwayService, boxId: string) => {
  const calls: string[] = []
  const l = {
    id: boxId,
    env: { name: 'box' },
    connected: true,
    calls,
    request: vi.fn(async (method: string, params?: unknown) => {
      if (!l.connected) throw new Error('box is not connected')
      calls.push(method)
      if (method === 'away.get') return box.get()
      if (method === 'away.apply') {
        const applied = box.apply((params as { state: Parameters<AwayService['apply']>[0] }).state)
        return { state: box.get().state, applied }
      }
      throw new Error(`unknown method ${method}`)
    })
  }
  return l
}

/** A Mac with one link to the box, its sync started, the box's push wired. */
const mac = (macId: string, box: AwayService, clock: { t: number }) => {
  const away = host(macId, clock)
  const l = link(box, 'env_box')
  const sync = new AwaySync({ away, peers: { get: () => l as never, all: () => [l as never] }, log: () => {} })
  sync.start()
  box.onChange((snapshot) => {
    if (l.connected) sync.onPeerPush('env_box', { push: 'away', ...snapshot })
  })
  return { away, link: l, sync }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AwaySync', () => {
  it('sends a flip on the Mac to the box', async () => {
    const clock = { t: 1_000 }
    const box = host('env_box', clock)
    const m = mac('env_mac', box, clock)
    m.away.set(true)
    await flush()
    expect(box.get().state).toEqual({ enabled: true, at: 1_000, by: 'env_mac' })
  })

  it('flips with the box down, and the box takes it on link-up', async () => {
    const clock = { t: 1_000 }
    const box = host('env_box', clock)
    const m = mac('env_mac', box, clock)
    m.link.connected = false
    m.away.set(true)
    await flush()
    expect(m.away.enabled).toBe(true)
    expect(box.enabled).toBe(false)
    m.link.connected = true
    await m.sync.linkUp('env_box')
    expect(box.get().state).toEqual({ enabled: true, at: 1_000, by: 'env_mac' })
  })

  it('takes the box state on link-up when the box flipped later', async () => {
    const clock = { t: 1_000 }
    const box = host('env_box', clock)
    const m = mac('env_mac', box, clock)
    m.away.set(true)
    await flush()
    m.link.connected = false
    clock.t = 2_000
    box.set(false)
    expect(m.away.enabled).toBe(true)
    m.link.connected = true
    await m.sync.linkUp('env_box')
    expect(m.away.get().state).toEqual({ enabled: false, at: 2_000, by: 'env_box' })
  })

  it("carries the box's flip to two Macs", async () => {
    const clock = { t: 1_000 }
    const box = host('env_box', clock)
    const a = mac('env_mac_a', box, clock)
    const b = mac('env_mac_b', box, clock)
    box.set(true)
    await flush()
    expect(a.away.get().state).toEqual({ enabled: true, at: 1_000, by: 'env_box' })
    expect(b.away.get().state).toEqual({ enabled: true, at: 1_000, by: 'env_box' })
  })

  it("never sends a peer's state back to it", async () => {
    const clock = { t: 1_000 }
    const box = host('env_box', clock)
    const m = mac('env_mac', box, clock)
    box.set(true)
    await flush()
    expect(m.away.enabled).toBe(true)
    expect(m.link.calls).not.toContain('away.apply')
  })

  it('leaves an older push alone', async () => {
    const clock = { t: 5_000 }
    const box = host('env_box', clock)
    const m = mac('env_mac', box, clock)
    m.away.set(true)
    expect(m.sync.onPeerPush('env_box', { push: 'away', state: { enabled: false, at: 4_000, by: 'env_box' }, decided: { since: 0, threads: [] } })).toBe(true)
    expect(m.away.enabled).toBe(true)
  })

  it('passes other pushes on', () => {
    const clock = { t: 1 }
    const m = mac('env_mac', host('env_box', clock), clock)
    expect(m.sync.onPeerPush('env_box', { push: 'resync' })).toBe(false)
  })
})
