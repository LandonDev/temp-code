import { useSyncExternalStore } from 'react'

/** Mirror of the main process's UpdateStatus (preload owns the source). */
export interface UpdateStatus {
  current: number
  latest: number | null
  notes: string
  canApply: boolean
  phase: 'idle' | 'checking' | 'building' | 'restarting' | 'error'
  error?: string
}

/** One shared subscription: the Settings row and the sidebar dot read the
 *  same snapshot without each opening an IPC channel. */
let snapshot: UpdateStatus | null = null
const subs = new Set<() => void>()
let started = false

function start(): void {
  if (started) return
  started = true
  void window.api.updates.get().then(publish)
  window.api.updates.onStatus(publish)
}

function publish(s: UpdateStatus): void {
  snapshot = s
  for (const fn of subs) fn()
}

export function useUpdateStatus(): UpdateStatus | null {
  return useSyncExternalStore(
    (onChange) => {
      start()
      subs.add(onChange)
      return () => subs.delete(onChange)
    },
    () => snapshot
  )
}

export const updateReady = (s: UpdateStatus | null): boolean =>
  !!s && s.canApply && s.latest !== null && s.latest > s.current
