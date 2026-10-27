import { registry } from '../lib/connection'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServiceId, ServiceView, UsageReport } from 'aliax-core/shared/types'
import { ACCOUNT_PROVIDERS, PROVIDER_OF, SERVICE_OF, type AccountHeadroom } from '@shared/accounts'
import { accountsStore, useAccounts } from '@renderer/stores/accounts'

export type Usage = Partial<Record<ServiceId, UsageReport[]>>
export type Headroom = Partial<Record<ServiceId, Record<string, AccountHeadroom>>>

const NONE: ReadonlySet<ServiceId> = new Set()

/**
 * Aliax's App data flow for the two pages. Services come from
 * `window.aliax.listServices()`; usage comes from temp-code's shared poll
 * (the accounts snapshot), never from a second poller.
 */
export function useAliax() {
  // Aliax's pages manage this machine's accounts; remote hosts keep their own.
  const { snapshot } = useAccounts(registry.primary().environmentId)
  const [views, setViews] = useState<ServiceView[] | null>(null)
  // A manual refresh drops these services' bars to skeletons so the reload is
  // visible; the background snapshot updates in place without the flash.
  const [masked, setMasked] = useState<ReadonlySet<ServiceId>>(NONE)

  const usage = useMemo(() => {
    const out: Usage = {}
    for (const p of ACCOUNT_PROVIDERS) {
      const id = SERVICE_OF[p]
      if (!masked.has(id)) out[id] = snapshot.providers[p].reports
    }
    return out
  }, [snapshot, masked])

  // The gateways' rate-limit picture rides the same snapshot; a refresh never masks it.
  const headroom = useMemo(() => {
    const out: Headroom = {}
    for (const p of ACCOUNT_PROVIDERS) {
      const h = snapshot.providers[p].headroom
      if (h) out[SERVICE_OF[p]] = h
    }
    return out
  }, [snapshot])

  // Responses can land out of order; only the newest list is kept.
  const seq = useRef(0)
  const loadViews = useCallback(async () => {
    const n = ++seq.current
    const services = await window.aliax.listServices()
    if (n === seq.current) setViews(services)
    return services
  }, [])

  const refreshing = useRef(false)
  const refreshUsage = useCallback(async (services: ServiceView[]) => {
    const active = services.filter((s) => s.installed && s.profiles.length > 0)
    setMasked(new Set(active.map((s) => s.id)))
    try {
      // One after another: the store ignores a refresh while one is running.
      for (const s of active) {
        const provider = PROVIDER_OF[s.id]
        if (provider) await accountsStore.refresh(registry.primary().environmentId, provider).catch(() => {})
      }
    } finally {
      setMasked(NONE)
    }
  }, [])

  const lastRefresh = useRef(0)
  const refresh = useCallback(
    async (force = false) => {
      if (!force && Date.now() - lastRefresh.current < 15_000) return
      lastRefresh.current = Date.now()
      if (!force) {
        await loadViews()
        return
      }
      refreshing.current = true
      try {
        await refreshUsage(await loadViews())
      } finally {
        refreshing.current = false
      }
    },
    [loadViews, refreshUsage]
  )

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => refresh(), 5 * 60_000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    // A switch made elsewhere has to show up here immediately.
    const unsubscribe = window.aliax.onAccountsChanged(() => {
      lastRefresh.current = 0
      void refresh()
    })
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [refresh])

  // A switch or an add made elsewhere (Aliax's window, a failover) re-labels
  // the active account: re-read the services when the snapshot's identities
  // move, never on a plain usage poll. The mount read above covers the first
  // one, and a manual refresh re-reads them itself.
  const identity = useMemo(
    () =>
      ACCOUNT_PROVIDERS.map((p) => {
        const s = snapshot.providers[p]
        return `${s.pinned ?? ''}:${s.profiles.map((x) => `${x.name}${x.active ? '*' : ''}`).join(',')}`
      }).join('|'),
    [snapshot]
  )
  const seen = useRef(identity)
  useEffect(() => {
    if (identity === seen.current) return
    seen.current = identity
    if (!refreshing.current) void loadViews()
  }, [identity, loadViews])

  return { views, usage, headroom, refresh, snapshot }
}
