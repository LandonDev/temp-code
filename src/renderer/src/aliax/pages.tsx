import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import type { ServiceId, ServiceView, UsageReport } from 'aliax-core/shared/types'
import { ACCOUNT_PROVIDERS, PROVIDER_OF, SERVICE_OF } from '@shared/accounts'
import { accountsStore, useAccounts } from '@renderer/stores/accounts'
import { Loader } from '@aliax/components/motion/loader'
import { Button } from '@aliax/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@aliax/components/ui/dialog'
import { Toaster } from '@aliax/components/ui/sonner'
import { TooltipProvider } from '@aliax/components/ui/tooltip'
import { EASE_OUT } from '@aliax/lib/ease'
import { AccountsView, SectionSkeleton } from '@aliax/views/accounts'
import { StatsView } from '@aliax/views/stats'
import './aliax.css'

type Usage = Partial<Record<ServiceId, UsageReport[]>>

const NONE: ReadonlySet<ServiceId> = new Set()

/**
 * Aliax's App data flow for the two pages. Services come from
 * `window.aliax.listServices()`; usage comes from temp-code's shared poll
 * (the accounts snapshot), never from a second poller.
 */
function useAliax() {
  const { snapshot } = useAccounts()
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
        if (provider) await accountsStore.refresh(provider).catch(() => {})
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

  return { views, usage, refresh }
}

function AliaxRoot({ page, children }: { page: 'accounts' | 'stats'; children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <TooltipProvider delayDuration={400}>
      <div className="aliax-root flex h-full min-h-0 flex-col">
        <main className="flex-1 overflow-y-auto pt-8">
          <motion.div
            key={page}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="mx-auto flex h-full w-full max-w-[62rem] flex-col px-8 pb-24"
          >
            {children}
          </motion.div>
        </main>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}

function Loading() {
  return (
    <div className="space-y-4">
      <SectionSkeleton />
      <SectionSkeleton />
      <SectionSkeleton />
    </div>
  )
}

export function AccountsPage(): React.JSX.Element {
  const { views, usage, refresh } = useAliax()
  const [busy, setBusy] = useState<string | null>(null)
  const [loginService, setLoginService] = useState<ServiceId | null>(null)

  const run = async (
    key: string,
    action: () => Promise<{ ok: boolean; error?: string; notes?: string[] }>,
    successFallback = 'Done'
  ) => {
    setBusy(key)
    const result = await action()
    setBusy(null)
    if (result.ok) toast.success(result.notes?.length ? result.notes.join(' · ') : successFallback)
    else toast.error(result.error ?? 'Something went wrong')
    await refresh(true)
  }

  const onUse = (serviceId: ServiceId, name: string) =>
    run(`use:${serviceId}:${name}`, () => window.aliax.activate(serviceId, name), 'Switched')

  /**
   * Adding never switches. Offer the switch as the next step instead. A hint
   * pre-fills the address so an expired account signs itself back in with one
   * click; re-signing the same email refreshes the existing row in place.
   */
  const addAccount = async (serviceId: ServiceId, loginHint?: string) => {
    setLoginService(serviceId)
    const result = await window.aliax.loginStart(serviceId, loginHint)
    setLoginService(null)
    if (!result.ok) {
      toast.error(result.error ?? 'Sign-in failed')
    } else {
      const added = result.name ? `Added ${result.name}` : 'Account added'
      toast.success(result.notes?.length ? `${added} · ${result.notes.join(' · ')}` : added, {
        action: result.name
          ? { label: 'Switch to it', onClick: () => onUse(serviceId, result.name as string) }
          : undefined
      })
    }
    await refresh(true)
  }

  const cancelLogin = () => {
    if (!loginService) return
    window.aliax.loginCancel(loginService)
    setLoginService(null)
  }

  const loginName = views?.find((v) => v.id === loginService)?.name ?? ''

  return (
    <AliaxRoot page="accounts">
      {views === null ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <AccountsView
            views={views}
            usage={usage}
            busy={busy}
            onCapture={(id) => run(`capture:${id}`, () => window.aliax.capture(id), 'Saved')}
            onAdd={addAccount}
            onReauth={(id, email) => addAccount(id, email)}
            onUse={onUse}
            onDelete={(id, name) =>
              run(`use:${id}:${name}`, () => window.aliax.remove(id, name), 'Removed')
            }
            onRefresh={() => refresh(true)}
          />
        </div>
      )}

      <Dialog open={loginService !== null} onOpenChange={(open) => !open && cancelLogin()}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Sign in to {loginName}</DialogTitle>
            <DialogDescription>
              Finish signing in the window that opened. Saving does not switch to it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 py-2 text-muted-foreground">
            <Loader variant="dots" size={20} />
            <span className="text-sm">Waiting for sign-in</span>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelLogin}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AliaxRoot>
  )
}

export function StatsPage(): React.JSX.Element {
  const { views, usage } = useAliax()
  return (
    <AliaxRoot page="stats">
      {views === null ? <Loading /> : <StatsView usage={usage} services={views} />}
    </AliaxRoot>
  )
}
