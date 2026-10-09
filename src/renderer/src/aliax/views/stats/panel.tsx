import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@aliax/lib/utils'

/**
 * Charts are expensive to mount, and this page holds twenty of them. Each one
 * waits until its panel is near the viewport, so opening Stats renders a
 * screenful rather than the whole document. Once shown, it stays mounted so
 * scrolling back is instant.
 */
function useNearViewport<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || !ref.current) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setSeen(true)
      },
      { rootMargin: '400px' }
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

/** A titled chart surface. The title names the measure so a single series needs no legend. */
export function Panel({
  title,
  hint,
  aside,
  className,
  bodyClassName,
  children
}: {
  title: string
  hint?: string
  aside?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  const [ref, visible] = useNearViewport<HTMLElement>()
  return (
    <section ref={ref} className={cn('panel flex flex-col overflow-hidden', className)}>
      <header className="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          {hint && <p className="pt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {aside}
      </header>
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{visible ? children : null}</div>
    </section>
  )
}

/** A number that is the whole answer — no plot, per the "is it even a chart" test. */
export function Stat({
  label,
  value,
  sub,
  tone
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'warning' | 'critical'
}) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'pt-1 text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'good' && 'text-ax-success',
          tone === 'warning' && 'text-ax-warning',
          tone === 'critical' && 'text-destructive'
        )}
      >
        {value}
      </div>
      {sub && <div className="pt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center px-4 pb-4 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  )
}
