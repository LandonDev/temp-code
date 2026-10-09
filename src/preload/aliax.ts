import { ipcRenderer } from 'electron'
import type { ActionResult, ServiceId, ServiceView } from 'aliax-core/shared/types'
import type { StatsBundle, StatsStatus } from '../shared/aliaxStats'

/**
 * `window.aliax`: the slice of Aliax's own preload the Accounts and Stats
 * pages call, name for name, so those pages run here unchanged. Usage
 * reports are NOT here: the pages read them from the server's accounts
 * snapshot (one shared poll, see src/main/server/accounts.ts), so the
 * embedded pages never add a second poller.
 */
export const aliaxApi = {
  listServices: (): Promise<ServiceView[]> => ipcRenderer.invoke('aliax:services:list'),
  capture: (serviceId: ServiceId): Promise<ActionResult> =>
    ipcRenderer.invoke('aliax:profiles:capture', serviceId),
  activate: (serviceId: ServiceId, name: string): Promise<ActionResult> =>
    ipcRenderer.invoke('aliax:profiles:activate', serviceId, name),
  remove: (serviceId: ServiceId, name: string): Promise<ActionResult> =>
    ipcRenderer.invoke('aliax:profiles:delete', serviceId, name),
  loginStart: (serviceId: ServiceId, loginHint?: string): Promise<ActionResult> =>
    ipcRenderer.invoke('aliax:login:start', serviceId, loginHint),
  loginCancel: (serviceId: ServiceId): Promise<void> =>
    ipcRenderer.invoke('aliax:login:cancel', serviceId),
  updateProfile: (
    serviceId: ServiceId,
    name: string,
    patch: { nickname?: string; color?: string }
  ): Promise<ActionResult> => ipcRenderer.invoke('aliax:profiles:update', serviceId, name, patch),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('aliax:open:external', url),
  /** Fires when accounts change outside the page (a switch, a failover, Aliax's own writes). */
  onAccountsChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('aliax:accounts:changed', listener)
    return () => ipcRenderer.removeListener('aliax:accounts:changed', listener)
  },
  stats: (): Promise<StatsBundle> => ipcRenderer.invoke('aliax:stats:get'),
  statsStatus: (): Promise<StatsStatus> => ipcRenderer.invoke('aliax:stats:status'),
  statsReindex: (): Promise<ActionResult> => ipcRenderer.invoke('aliax:stats:reindex')
}

export type AliaxApi = typeof aliaxApi
