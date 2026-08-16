import { memo, useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Check, TriangleAlert } from 'lucide-react'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { duration } from '../bits'

type CompactionBlock = Extract<Block, { kind: 'compaction' }>

const fmt = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

/**
 * Compaction is not normal working — it gets its own violet moment.
 * While running: a distinct card with an animated progress bar (eases
 * toward 90% the way the harness's own UI does, completes on the
 * boundary) and elapsed time. Settled: a quiet divider with the
 * numbers — 412k → 65k · 18s · auto.
 */
export const CompactionCard = memo(function CompactionCard({
  block
}: {
  block: CompactionBlock
}): React.JSX.Element {
  if (block.phase === 'start') return <ActiveCompaction startedAt={block.ts} />
  if (block.phase === 'failed') {
    return (
      <div className="flex max-w-[95%] items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        <span className="text-foreground/85">
          Compaction failed{block.error ? ` — ${block.error}` : ''}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 py-1" role="note" aria-label="Context compacted">
      <span className="h-px flex-1 bg-violet/25" />
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-violet">
        <Check className="size-3" />
        Context compacted
        <span className="tabular-nums text-muted-foreground">
          {block.preTokens !== undefined && block.postTokens !== undefined
            ? ` ${fmt(block.preTokens)} → ${fmt(block.postTokens)}`
            : block.preTokens !== undefined
              ? ` ${fmt(block.preTokens)} compacted`
              : ''}
          {block.durationMs ? ` · ${duration(block.durationMs)}` : ''}
          {block.trigger ? ` · ${block.trigger}` : ''}
        </span>
      </span>
      <span className="h-px flex-1 bg-violet/25" />
    </div>
  )
})

/** The live card: eased pseudo-progress (real completion signal is the
 *  boundary event replacing this block), elapsed clock, violet family. */
function ActiveCompaction({ startedAt }: { startedAt?: number }): React.JSX.Element {
  const reduce = useReducedMotion()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, now - (startedAt ?? now))
  // Ease toward 90% over ~45s; the done event replaces this card entirely.
  const pct = Math.min(90, 100 * (1 - Math.exp(-elapsed / 20_000)))

  return (
    <div className="max-w-[95%] rounded-xl border border-violet/25 bg-violet/[0.05] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] font-medium text-violet">
          <motion.span
            className="size-2 rounded-full bg-violet"
            animate={reduce ? undefined : { opacity: [1, 0.35, 1] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          />
          Compacting context…
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{duration(elapsed)}</span>
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-violet/15">
        <motion.div
          className={cn('h-full rounded-full bg-violet')}
          animate={{ width: `${pct}%` }}
          transition={{ ease: 'linear', duration: 0.5 }}
        />
      </div>
    </div>
  )
}
