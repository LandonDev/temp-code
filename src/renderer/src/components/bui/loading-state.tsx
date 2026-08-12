import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { cn } from '../../lib/utils'
import { TextShimmer } from '../motion/text-shimmer'

/**
 * Beautiful UI "Loading State" (beautifului.dev #loading-state), Drive
 * variant, adapted to our tokens: a 3×3 pixel grid whose chevron wavefront
 * drives right, a shimmering label, and a live elapsed timer. Reduced
 * motion freezes the grid to its dim state; the timer still ticks.
 */

/** Chevron wavefront: delay (c + |r−1|) · 90ms per cell. */
const DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3)
  const c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

function useElapsed(): string {
  const [ds, setDs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100)
    return () => clearInterval(t)
  }, [])
  const total = ds / 10
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

export function LoadingState({
  label = 'Working',
  className
}: {
  label?: string
  className?: string
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const elapsed = useElapsed()
  return (
    <div className={cn('flex w-fit items-center gap-2.5', className)}>
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {DELAYS.map((d, i) => (
          <span
            key={i}
            className="size-[4px] rounded-[1px] bg-foreground"
            style={{
              opacity: 0.15,
              animation: reduce ? 'none' : `pixel-on 650ms ease-in-out ${d}ms infinite`
            }}
          />
        ))}
      </span>
      <TextShimmer className="text-[13px] font-medium">{label}</TextShimmer>
      <span className="font-mono text-xs text-muted-foreground/60 tabular-nums">{elapsed}</span>
    </div>
  )
}
