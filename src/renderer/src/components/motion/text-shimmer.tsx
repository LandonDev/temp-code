import { useReducedMotion } from 'motion/react'
import { cn } from '../../lib/utils'

/**
 * BeUI-style shimmer: a soft highlight sweeps through the text while a
 * background process runs. Reduced motion falls back to static muted text.
 */
export function TextShimmer({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const reduce = useReducedMotion()
  if (reduce) return <span className={cn('text-muted-foreground', className)}>{children}</span>
  return (
    <span
      className={cn(
        'animate-[text-shimmer_1.4s_linear_infinite] bg-[linear-gradient(90deg,var(--muted-foreground)_35%,var(--foreground)_50%,var(--muted-foreground)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent',
        className
      )}
    >
      {children}
    </span>
  )
}
