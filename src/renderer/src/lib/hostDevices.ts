import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { HostDevicesHost, HostDevicesReport } from '@server/shared/contract-hostdevices'
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry } from './connection/registry'
import { isWebMode } from './nativeWeb'

/**
 * Devices on a Mac in the renderer (docs/box.md "Devices on the Mac"). The
 * pane asks its own server (the local link on the desktop, the host's link
 * in web mode) which Macs it can show, opens a viewer on one with
 * `host.devices.watch` while the row is mounted, and takes the `host.devices`
 * push every 30 s. Unmounting sends `host.devices.unwatch`, so nothing runs
 * on the Mac once the pane is gone.
 */

type State = {
  hosts: HostDevicesHost[] | null
  reports: Record<string, HostDevicesReport>
  errors: Record<string, string>
}

const store = createStore<State>(() => ({ hosts: null, reports: {}, errors: {} }))
export const hostDevicesStore = store

/** The link the pane speaks on: this host's own server. Tests swap `get`. */
export const hostDevicesLink = {
  get: (): Pick<NonNullable<ReturnType<typeof registry.link>>, 'connected' | 'request' | 'onPush'> | undefined =>
    registry.link(isWebMode() ? WEB_ENVIRONMENT_ID : LOCAL_ENVIRONMENT_ID)
}
const link = () => hostDevicesLink.get()

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Which Macs this pane can show; null until the server answered (an older server never does). */
export async function refreshHostDevicesHosts(): Promise<HostDevicesHost[]> {
  const l = link()
  if (!l?.connected) return []
  const hosts = await l.request<HostDevicesHost[]>('host.devices.hosts', {})
  store.setState({ hosts })
  return hosts
}

/** The viewers open in this window, by Mac, so two rows of one Mac share one watch. */
const viewers = new Map<string, { count: number; off: () => void }>()

function open(environmentId: string): () => void {
  const l = link()
  const existing = viewers.get(environmentId)
  if (existing) {
    existing.count++
    return () => release(environmentId)
  }
  const offPush = l
    ? l.onPush((push) => {
        if (push.push === 'host.devices' && push.report.environmentId === environmentId) land(push.report)
      })
    : () => {}
  viewers.set(environmentId, { count: 1, off: offPush })
  void (async () => {
    if (!l?.connected) return
    try {
      land(await l.request<HostDevicesReport>('host.devices.watch', { environmentId }))
    } catch (err) {
      store.setState((s) => ({ errors: { ...s.errors, [environmentId]: text(err) } }))
    }
  })()
  return () => release(environmentId)
}

function release(environmentId: string): void {
  const v = viewers.get(environmentId)
  if (!v) return
  if (--v.count > 0) return
  viewers.delete(environmentId)
  v.off()
  const l = link()
  if (l?.connected) void l.request('host.devices.unwatch', { environmentId }).catch(() => {})
}

function land(report: HostDevicesReport): void {
  store.setState((s) => {
    const errors = { ...s.errors }
    delete errors[report.environmentId]
    return { reports: { ...s.reports, [report.environmentId]: report }, errors }
  })
}

export function useHostDevicesHosts(): HostDevicesHost[] | null {
  return useStore(store, (s) => s.hosts)
}

/** The report of one Mac while the caller is mounted: a viewer opens on mount and closes on unmount. */
export function useHostDevices(environmentId: string): { report: HostDevicesReport | null; error: string | null } {
  const report = useStore(store, (s) => s.reports[environmentId] ?? null)
  const error = useStore(store, (s) => s.errors[environmentId] ?? null)
  useEffect(() => open(environmentId), [environmentId])
  return { report, error }
}

async function act(method: string, params: Record<string, unknown>): Promise<HostDevicesReport> {
  const l = link()
  if (!l?.connected) throw new Error('not connected')
  const report = await l.request<HostDevicesReport>(method, params)
  land(report)
  return report
}

export const shutdownSimulator = (environmentId: string, udid: string): Promise<HostDevicesReport> =>
  act('host.simulator.shutdown', { environmentId, udid })

export const deleteSimulator = (environmentId: string, udid: string): Promise<HostDevicesReport> =>
  act('host.simulator.delete', { environmentId, udid })

export async function openXcodeDevices(environmentId: string): Promise<void> {
  const l = link()
  if (!l?.connected) throw new Error('not connected')
  await l.request('host.device.openXcode', { environmentId })
}

/** Viewers open right now (tests). */
export const openViewers = (): string[] => [...viewers.keys()]
