import { useEffect, useState } from 'react'
import type { ProfileView, UsageWindow } from 'aliax-core/shared/types'

export { ACCOUNT_COLORS, DEFAULT_COLOR } from 'aliax-core/shared/colors'

export const displayName = (p: ProfileView): string => p.nickname ?? p.email ?? p.name

/** Signed in somewhere, on any surface. */
export const isLive = (p: ProfileView): boolean => (p.activeOn?.length ?? 0) > 0 || p.active

// Pure and shared with the main process, so the menu bar and the window can
// never disagree about a bar's colour.
import { healthOf, type Health } from 'aliax-core/shared/health'
export { cycleMs, healthOf, onPaceLeft, percentLeft, type Health } from 'aliax-core/shared/health'

const TONE: Record<Health, string> = {
  good: 'text-ax-success',
  warning: 'text-ax-warning',
  critical: 'text-destructive'
}
const FILL: Record<Health, string> = {
  good: 'bg-ax-success',
  warning: 'bg-ax-warning',
  critical: 'bg-destructive'
}

export const toneFor = (w: UsageWindow, now: number): string => TONE[healthOf(w, now)]
export const fillFor = (w: UsageWindow, now: number): string => FILL[healthOf(w, now)]

/** Level-only fallback, for places with no window object to hand. */
export const leftTone = (left: number): string =>
  left <= 10 ? 'text-destructive' : left <= 30 ? 'text-ax-warning' : 'text-foreground'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** How far into the current cycle we are, 0 at refill and 1 just before the next. */
export function cycleFraction(resetsAt: number, period: number, now: number): number {
  return Math.min(1, Math.max(0, 1 - (resetsAt - now) / period))
}

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

/** The reset moment, as short as the distance allows: "5:30 PM", "Wed 5:30 PM", "Aug 22". */
export function resetPoint(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (at - now < DAY) return time
  if (at - now < 7 * DAY) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The current time, refreshed on an interval, so countdowns stay honest. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
