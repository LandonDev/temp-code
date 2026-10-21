import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerPush } from '@server/shared/contract'
import type { HostDevicesReport } from '@server/shared/contract-hostdevices'
import { mountProbe } from '../test/renderProbe'
import { hostDevicesLink, hostDevicesStore, openViewers, useHostDevices } from './hostDevices'

const report = (at: number): HostDevicesReport => ({
  environmentId: 'env_mac',
  at,
  simulators: [],
  phones: [],
  xcode: null,
  load: { oneMinute: 1, cores: 8 },
  problems: []
})

class FakeLink {
  connected = true
  calls: { method: string; params: unknown }[] = []
  listeners = new Set<(push: ServerPush) => void>()
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'host.devices.watch') return report(1) as T
    return { ok: true } as T
  }
  onPush(l: (push: ServerPush) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  push(push: ServerPush): void {
    for (const l of this.listeners) l(push)
  }
}

function Viewer({ id }: { id: string }) {
  const { report } = useHostDevices(id)
  return <span data-at>{report?.at ?? 'none'}</span>
}

describe('useHostDevices', () => {
  let link: FakeLink
  const original = hostDevicesLink.get
  beforeEach(() => {
    link = new FakeLink()
    hostDevicesLink.get = () => link
    hostDevicesStore.setState({ hosts: null, reports: {}, errors: {} })
  })
  afterEach(() => {
    hostDevicesLink.get = original
  })

  it('opens a viewer on mount, takes the pushes, and closes it on unmount so the Mac stops gathering', async () => {
    const probe = mountProbe(<Viewer id="env_mac" />)
    await probe.act(async () => {})
    expect(link.calls).toEqual([{ method: 'host.devices.watch', params: { environmentId: 'env_mac' } }])
    expect(probe.container.textContent).toBe('1')
    expect(openViewers()).toEqual(['env_mac'])
    probe.act(() => link.push({ push: 'host.devices', report: report(2) }))
    expect(probe.container.textContent).toBe('2')
    // Another Mac's push is not this row's.
    probe.act(() => link.push({ push: 'host.devices', report: { ...report(3), environmentId: 'env_other' } }))
    expect(probe.container.textContent).toBe('2')
    probe.unmount()
    await Promise.resolve()
    expect(link.calls.at(-1)).toEqual({ method: 'host.devices.unwatch', params: { environmentId: 'env_mac' } })
    expect(openViewers()).toEqual([])
    expect(link.listeners.size).toBe(0)
  })

  it('two rows of one Mac share a viewer; the last one leaving sends the unwatch', async () => {
    const a = mountProbe(<Viewer id="env_mac" />)
    const b = mountProbe(<Viewer id="env_mac" />)
    await a.act(async () => {})
    expect(link.calls.filter((c) => c.method === 'host.devices.watch').length).toBe(1)
    a.unmount()
    await Promise.resolve()
    expect(link.calls.some((c) => c.method === 'host.devices.unwatch')).toBe(false)
    b.unmount()
    await Promise.resolve()
    expect(link.calls.filter((c) => c.method === 'host.devices.unwatch').length).toBe(1)
  })

  it('a watch that fails lands as the row’s error', async () => {
    link.request = async () => {
      throw new Error('Landon’s Mac is not linked right now')
    }
    const probe = mountProbe(<Viewer id="env_mac" />)
    await probe.act(async () => {})
    expect(hostDevicesStore.getState().errors.env_mac).toBe('Landon’s Mac is not linked right now')
    probe.unmount()
  })
})
