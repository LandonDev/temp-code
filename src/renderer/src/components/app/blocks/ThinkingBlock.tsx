import { memo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../../lib/utils'

/** Reasoning stream, collapsed by default (docs/PLAN.md M3). */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          <span>Thought process</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 whitespace-pre-wrap pl-4 text-[13px] leading-relaxed text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
})
