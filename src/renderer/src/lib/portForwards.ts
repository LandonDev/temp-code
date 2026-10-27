import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ForwardHost } from '@server/shared/contract-ports'
import { LOCAL_ENVIRONMENT_ID, registry } from './connection/registry'
import { isWebMode } from './nativeWeb'

/**
 * This Mac's dev server forwards (docs/box.md "Dev servers on the box"): per
 * linked host, its switch and what it forwards here now, read from the local
 * server (`ports.forwards`) and kept current by its `port-forwards` push.
 * Settings → Hosts lists them in each host's Mac bridge group.
 */

const store = createStore<{ hosts: ForwardHost[] }>(() => ({ hosts: [] }))
const local = () => registry.link(LOCAL_ENVIRONMENT_ID)

async function load(): Promise<void> {
  const link = local()
  if (!link?.connected) return
  try {
    const { hosts } = await link.request<{ hosts: ForwardHost[] }>('ports.forwards', {})
    store.setState({ hosts })
  } catch {
    // An older server: no forwards to show.
  }
}

let started = false
function start(): void {
  if (started || isWebMode()) return
  const link = local()
  if (!link) return
  started = true
  link.onPush((push) => {
    if (push.push === 'port-forwards') store.setState({ hosts: push.hosts })
  })
  link.onOpen(() => void load())
  void load()
}

/** One host's forwards and switch; null before the first answer (or on an older server). */
export function useHostForwards(environmentId: string): ForwardHost | null {
  useEffect(start, [])
  return useStore(store, (s) => s.hosts.find((h) => h.environmentId === environmentId) ?? null)
}

export async function setForwarding(environmentId: string, enabled: boolean): Promise<void> {
  const link = local()
  if (!link) throw new Error('not connected')
  const { hosts } = await link.request<{ hosts: ForwardHost[] }>('ports.setForwarding', { environmentId, enabled })
  store.setState({ hosts })
}

export const portForwardsStore = store
