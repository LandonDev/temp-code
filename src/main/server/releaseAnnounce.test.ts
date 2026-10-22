import { describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import { ReleaseAnnouncer } from './releaseAnnounce'

describe('ReleaseAnnouncer', () => {
  it('the box: a green publish or deploy goes down every registered Mac socket, nothing to its own updater', () => {
    const sent: ServerFrame[] = []
    const box = new ReleaseAnnouncer({ environmentId: 'box', notify: (f) => sent.push(f) })
    box.announce('v1.0.283')
    box.announce('1.0.284')
    box.announce('master')
    expect(sent).toEqual([
      { push: 'release-available', from: 'box', version: '1.0.283' },
      { push: 'release-available', from: 'box', version: '1.0.284' }
    ])
  })

  it('the Mac: the push on its link reaches its updater; other pushes are left to the next handler', async () => {
    const selfUpdate = vi.fn(async () => 'ready' as const)
    const log: string[] = []
    const mac = new ReleaseAnnouncer({ environmentId: 'mac', selfUpdate, log: (l) => log.push(l) })
    expect(mac.onPeerPush('box', { push: 'release-available', from: 'box', version: '1.0.283' })).toBe(true)
    expect(mac.onPeerPush('box', { push: 'memory.nudge', from: 'box' })).toBe(false)
    expect(mac.onPeerPush('box', { push: 'release-available', from: 'box', version: 'junk' } as never)).toBe(true)
    await Promise.resolve()
    expect(selfUpdate).toHaveBeenCalledTimes(1)
    expect(selfUpdate).toHaveBeenCalledWith('1.0.283')
    expect(log).toEqual(['[release] 1.0.283 from box: ready'])
  })

  it('the Mac running its own batch: announce goes to the local updater and to the box it links (which ignores it)', async () => {
    const selfUpdate = vi.fn(async () => 'current' as const)
    const sent: ServerFrame[] = []
    const mac = new ReleaseAnnouncer({ environmentId: 'mac', selfUpdate, notify: (f) => sent.push(f) })
    mac.announce('1.0.283')
    await Promise.resolve()
    expect(selfUpdate).toHaveBeenCalledWith('1.0.283')
    expect(sent).toHaveLength(1)
    const box = new ReleaseAnnouncer({ environmentId: 'box' })
    expect(box.onPeerPush('mac', sent[0] as never)).toBe(true)
  })

  it('a failing updater is logged, never thrown', async () => {
    const log: string[] = []
    const mac = new ReleaseAnnouncer({
      environmentId: 'mac',
      selfUpdate: async () => {
        throw new Error('no feed')
      },
      log: (l) => log.push(l)
    })
    mac.announce('1.0.283')
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual(['[release] 1.0.283 from this host: no feed'])
  })
})
