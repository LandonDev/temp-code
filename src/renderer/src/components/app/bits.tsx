import type { LucideIcon } from 'lucide-react'
import { GitFork, ListChecks, Map as MapIcon, MessageSquare, Telescope } from 'lucide-react'
import type { ThreadType } from '@shared/domain'
import type { ProviderId } from '@shared/catalog'
import type { SessionStatus } from '@shared/events'
import { cn } from '../../lib/utils'
import { ZIcon, type ZIconName } from './zicon'

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
  orchestration: GitFork,
  research: Telescope
}

export const THREAD_LABELS: Record<ThreadType, string> = {
  chat: 'Chat',
  planning: 'Plan',
  implementation: 'Implement',
  orchestration: 'Orchestrate',
  research: 'Research'
}

/** Identity tint per thread type — the glyph carries it, nothing else. */
export const THREAD_TINTS: Record<ThreadType, string> = {
  chat: 'text-info',
  planning: 'text-violet',
  implementation: 'text-success',
  orchestration: 'text-warning',
  research: 'text-cyan'
}

/** Brand mark + tint per provider (Zeron harness_brand_icon: the Claude
 * mark keeps its copper even on the monochrome surface; OpenAI and Cursor
 * marks stay monochrome and inherit the surface tone). */
const PROVIDER_MARKS: Record<ProviderId, { icon: ZIconName; tint?: string }> = {
  claude: { icon: 'claude-mark', tint: 'text-[#D97757]' },
  codex: { icon: 'openai-mark' },
  cursor: { icon: 'cursor-mark' }
}

export function ProviderMark({
  provider,
  size = 14,
  className
}: {
  provider: ProviderId
  size?: number
  className?: string
}): React.JSX.Element {
  const mark = PROVIDER_MARKS[provider]
  return <ZIcon name={mark.icon} size={size} className={cn(mark.tint, className)} />
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
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}
