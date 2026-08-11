import type { LucideIcon } from 'lucide-react'
import { GitFork, ListChecks, Map as MapIcon, MessageSquare } from 'lucide-react'
import type { ThreadType } from '@shared/domain'
import type { ProviderId } from '@shared/catalog'
import type { SessionStatus } from '@shared/events'
import { cn } from '../../lib/utils'

/** The one place status → color lives. Dots carry meaning; nothing else is colored. */
export function StatusDot({
  status,
  className
}: {
  status: SessionStatus
  className?: string
}): React.JSX.Element | null {
  const color: Partial<Record<SessionStatus, string>> = {
    running: 'bg-success animate-pulse',
    waiting: 'bg-warning animate-pulse',
    error: 'bg-destructive',
    starting: 'bg-muted-foreground animate-pulse'
  }
  const c = color[status]
  if (!c) return null
  return <span className={cn('size-1.5 shrink-0 rounded-full', c, className)} />
}

export const THREAD_GLYPHS: Record<ThreadType, LucideIcon> = {
  chat: MessageSquare,
  planning: MapIcon,
  implementation: ListChecks,
  orchestration: GitFork
}

export const THREAD_LABELS: Record<ThreadType, string> = {
  chat: 'Chat',
  planning: 'Plan',
  implementation: 'Implement',
  orchestration: 'Orchestrate'
}

/** Quiet monogram — provider identity without brand noise. */
export function ProviderMark({
  provider,
  className
}: {
  provider: ProviderId
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-secondary text-[9px] font-semibold uppercase text-muted-foreground',
        className
      )}
    >
      {provider[0]}
    </span>
  )
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
}
