import { memo, useState } from 'react'
import { ChevronDown, Sparkle } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { TextShimmer } from '../../motion/text-shimmer'

function durationLabel(ms?: number): string {
  if (ms === undefined) return 'Thought for a moment'
  const s = Math.round(ms / 1000)
  if (s < 1) return 'Thought for a moment'
  return s < 60 ? `Thought for ${s} seconds` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Beautiful UI "Thinking" (beautifului.dev #thinking-state) on real
 * reasoning events: sparkle + shimmering label while the model thinks (the
 * freshest line ghosted underneath), a settled duration afterwards, and the
 * full trace expanding on a grid-rows transition behind a guide line.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming,
  thoughtMs
}: {
  text: string
  streaming: boolean
  thoughtMs?: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tail = streaming && !open ? text.trimEnd().split('\n').at(-1)?.trim() : undefined

  return (
    <div>
      <button
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-100 hover:bg-accent/50"
      >
        <Sparkle
          className={cn(
            'size-3.5 shrink-0',
            streaming
              ? 'fill-muted-foreground text-muted-foreground'
              : 'fill-muted-foreground/50 text-muted-foreground/50'
          )}
        />
        {streaming ? (
          <TextShimmer className="text-[13px] font-medium whitespace-nowrap">Thinking</TextShimmer>
        ) : (
          <span className="animate-[fade-in_350ms_ease-out_both] text-[13px] font-medium whitespace-nowrap text-muted-foreground">
            {durationLabel(thoughtMs)}
          </span>
        )}
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-300"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        />
      </button>
      {tail && (
        <p className="mt-0.5 truncate pl-6 text-[11px] leading-4 text-muted-foreground/50">
          {tail}
        </p>
      )}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)'
        }}
      >
        <div className="overflow-hidden">
          <div className="mt-1 ml-[5px] border-l border-border/60 py-1 pl-4">
            <p className="animate-[fade-up_320ms_cubic-bezier(0.23,1,0.32,1)_both] whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
              {text}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
