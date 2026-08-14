import { memo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { TextShimmer } from '../../motion/text-shimmer'
import { ZIcon } from '../zicon'

function durationLabel(ms?: number): string {
  if (ms === undefined) return 'Thought for a moment'
  const s = Math.round(ms / 1000)
  if (s < 1) return 'Thought for a moment'
  return s < 60 ? `Thought for ${s} seconds` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Thinking renders in the same quiet idiom as tool groups: a 26px header —
 * 18px chevron tile, 12px muted label — expanding along a guide rail.
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
        className="flex h-[26px] w-full items-center gap-2 px-1 text-left text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-(--tile) text-muted-foreground/70">
          <ZIcon
            name="alt-arrow-right"
            size={10}
            className={cn('transition-transform duration-200', open && 'rotate-90')}
          />
        </span>
        {streaming ? (
          <TextShimmer className="text-xs whitespace-nowrap">Thinking</TextShimmer>
        ) : (
          <span className="truncate">{durationLabel(thoughtMs)}</span>
        )}
      </button>
      {tail && <p className="truncate pl-[26px] text-[11px] leading-4 text-faint">{tail}</p>}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="relative">
            <div className="absolute top-0 bottom-0 left-3 w-px bg-(--rail)" />
            <p className="ml-6 py-1 text-xs leading-[18px] whitespace-pre-wrap text-muted-foreground">
              {text}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
