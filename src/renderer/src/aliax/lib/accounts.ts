import { useEffect, useState } from 'react'
import type { ProfileView, UsageWindow } from 'aliax-core/shared/types'
import type { ProgressFill } from '@renderer/components/ui/progress'

export { ACCOUNT_COLORS, DEFAULT_COLOR } from 'aliax-core/shared/colors'

export const displayName = (p: ProfileView): string => p.nickname ?? p.email ?? p.name

/** Signed in somewhere, on any surface. */
export const isLive = (p: ProfileView): boolean => (p.activeOn?.length ?? 0) > 0 || p.active

// Pure and shared with the main process, so the menu bar and the window can
// never disagree about a bar's colour.
import { healthOf, type Health } from 'aliax-core/shared/health'
export { cycleMs, healthOf, onPaceLeft, percentLeft, type Health } from 'aliax-core/shared/health'

/** Room running low is amber, never red: red is for failures. */
const LOW: Record<Health, boolean> = { good: false, warning: true, critical: true }

export const fillFor = (w: UsageWindow, now: number): ProgressFill => (LOW[healthOf(w, now)] ? 'warning' : 'muted')
export const toneFor = (w: UsageWindow, now: number): string =>
  LOW[healthOf(w, now)] ? 'text-warning' : 'text-muted-foreground'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Compact time until refill: "2h 14m", "3d 4h", "under a minute". */
export function untilLabel(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms < 60_000) return 'under a minute'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / 60_000)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export const resetLabel = (at: number): string =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** The current time, refreshed on an interval, so countdowns stay honest. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
