import { useEffect, useState } from 'react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Spinner } from '../ui/spinner'

/**
 * The context meter: a tiny usage ring in the composer's meta row that
 * opens into the full /context breakdown — categories on a stacked bar,
 * token counts, memory files, MCP tools — plus the context-window
 * control (standard vs 1M beta).
 */

interface Category {
  name: string
  tokens: number
  color: string
}

interface ContextUsage {
  categories: Category[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  memoryFiles?: { path: string; type: string; tokens: number }[]
  mcpTools?: { name: string; serverName: string; tokens: number }[]
  systemTools?: { name: string; tokens: number }[]
}

const fmt = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

/** The harness sends named colors; anything unparseable falls back. */
const FALLBACK = ['#7c86ff', '#4ade80', '#fbbf24', '#f87171', '#38bdf8', '#c084fc', '#a3a3a3']
function tint(c: string, ix: number): string {
  return /^#|^rgb|^hsl|^oklch/.test(c) ? c : FALLBACK[ix % FALLBACK.length]
}

/** The usage ring alone — the composer meter and the fleet rows share it. */
export function UsageRing({
  pct,
  className
}: {
  pct: number | null
  className?: string
}): React.JSX.Element {
  const r = 4.5
  const c = 2 * Math.PI * r
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={cn('shrink-0 -rotate-90', className)}
    >
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="1.5" className="stroke-border" />
      {pct !== null && (
        <circle
          cx="6"
          cy="6"
          r={r}
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          className={cn(
            pct > 85 ? 'stroke-destructive' : pct > 65 ? 'stroke-warning' : 'stroke-success'
          )}
        />
      )}
    </svg>
  )
}

export function ContextMeter({ sessionId }: { sessionId: string }): React.JSX.Element {
  const usage = useApp((s) => s.contexts[sessionId]) as ContextUsage | null | undefined
  const session = useApp((s) => s.sessions[sessionId])
  const fetchContext = useApp((s) => s.fetchContext)
  const [open, setOpen] = useState(false)

  // Live accounting — but only between turns. A streaming harness can't
  // answer the control request, and a queue of mid-turn requests can cost
  // the stream its result message (the "working forever" wedge) — so while
  // a turn runs, nothing is fetched; the store refreshes on the idle
  // transition and the open popover polls the settled harness.
  const running = session?.status === 'running' || session?.status === 'starting'
  const [answered, setAnswered] = useState(false)
  // Reset per open/session during render (canonical prev-state pattern).
  const [prevKey, setPrevKey] = useState('')
  const key = `${open}:${sessionId}`
  if (key !== prevKey) {
    setPrevKey(key)
    setAnswered(false)
  }
  useEffect(() => {
    if (!open || running) return
    void fetchContext(sessionId).finally(() => setAnswered(true))
    const t = setInterval(() => void fetchContext(sessionId), 3000)
    return () => clearInterval(t)
  }, [open, running, sessionId, fetchContext])

  const hasMax = !!usage && usage.maxTokens > 0
  const pct = usage && hasMax ? Math.min(100, Math.round(usage.percentage)) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title="Context usage"
          className={cn(
            'flex items-center gap-1.5 rounded-full px-1.5 py-0.5 transition-colors hover:text-foreground',
            open && 'text-foreground'
          )}
        >
          <UsageRing pct={pct} />
          {pct !== null ? `${pct}%` : usage ? fmt(usage.totalTokens) : 'Context'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 rounded-xl p-0">
        {!usage ? (
          <div className="flex h-24 items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            {running ? (
              <>Context updates when this turn settles.</>
            ) : !answered ? (
              <Spinner className="size-3.5" />
            ) : (
              <>Context loads after the next reply.</>
            )}
          </div>
        ) : (
          <div className="p-3">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <span className="text-[13px] font-medium">Context</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {hasMax
                  ? `${fmt(usage.totalTokens)} / ${fmt(usage.maxTokens)} · ${Math.round(usage.percentage)}%`
                  : `${fmt(usage.totalTokens)} used · window unknown`}
              </span>
            </div>

            {/* stacked usage bar */}
            <div
              className={cn(
                'mt-2 flex h-1.5 overflow-hidden rounded-full bg-secondary/70',
                !hasMax && 'hidden'
              )}
            >
              {usage.categories
                .filter((cat) => cat.tokens > 0)
                .map((cat, ix) => (
                  <span
                    key={cat.name}
                    title={`${cat.name} · ${fmt(cat.tokens)}`}
                    style={{
                      width: `${(cat.tokens / usage.maxTokens) * 100}%`,
                      background: tint(cat.color, ix)
                    }}
                  />
                ))}
            </div>

            <div className="mt-2.5 flex flex-col gap-1 px-1">
              {usage.categories.map((cat, ix) => (
                <div key={cat.name} className="flex items-center gap-2 text-[11.5px]">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: tint(cat.color, ix) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground/85 capitalize">
                    {cat.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {fmt(cat.tokens)}
                  </span>
                </div>
              ))}
            </div>

            {(usage.memoryFiles?.length ?? 0) > 0 && (
              <BreakdownList
                title="Memory files"
                rows={usage.memoryFiles!.map((f) => ({
                  key: f.path,
                  label: f.path.split('/').slice(-2).join('/'),
                  tokens: f.tokens
                }))}
              />
            )}
            {(usage.mcpTools?.length ?? 0) > 0 && (
              <BreakdownList
                title="MCP tools"
                rows={usage.mcpTools!.map((t) => ({
                  key: `${t.serverName}:${t.name}`,
                  label: `${t.serverName} · ${t.name}`,
                  tokens: t.tokens
                }))}
              />
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function BreakdownList({
  title,
  rows
}: {
  title: string
  rows: { key: string; label: string; tokens: number }[]
}): React.JSX.Element {
  const shown = rows.slice(0, 6)
  return (
    <div className="mt-3 border-t border-border/50 px-1 pt-2">
      <p className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase">
        {title}
      </p>
      <div className="mt-1 flex flex-col gap-0.5">
        {shown.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/75">
              {r.label}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(r.tokens)}</span>
          </div>
        ))}
        {rows.length > shown.length && (
          <span className="text-[10.5px] text-muted-foreground/60">
            +{rows.length - shown.length} more
          </span>
        )}
      </div>
    </div>
  )
}
