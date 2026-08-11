import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../../state/store'
import type { Block } from '../../state/blocks'
import { ApprovalCard } from './blocks/ApprovalCard'
import { MarkdownText } from './blocks/MarkdownText'
import { ThinkingBlock } from './blocks/ThinkingBlock'
import { ToolChip } from './blocks/ToolChip'

/**
 * Virtualized transcript over the store's incrementally-folded blocks
 * (docs/PLAN.md M3). Rows are memoized; a streaming delta re-renders only
 * the one block whose object identity changed.
 */

const BlockRow = memo(function BlockRow({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'user':
      return (
        <div className="ml-auto max-w-[80%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {block.text}
        </div>
      )
    case 'assistant':
      return (
        <div className="max-w-[95%] text-sm leading-relaxed">
          <MarkdownText text={block.text} streaming={block.streaming} />
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={block.text} streaming={block.streaming} />
    case 'tool':
      return <ToolChip block={block} />
    case 'approval':
      return <ApprovalCard block={block} />
    case 'error':
      return (
        <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {block.text}
        </div>
      )
  }
})

export function Transcript(): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedId)
  const blocks = useApp((s) => (s.selectedId ? s.blocks[s.selectedId] : undefined)) ?? []
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
    getItemKey: (i) => blocks[i].id
  })

  // Track whether the user is pinned to the bottom; only then follow output.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [selectedId])

  const last = blocks.at(-1)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [last, blocks.length])

  // New session selected: jump to the end.
  useLayoutEffect(() => {
    atBottomRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [selectedId])

  if (!selectedId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a session
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto select-text">
      <div className="relative mx-auto w-full px-6" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute right-6 left-6"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <div className="py-2">
              <BlockRow block={blocks[item.index]} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
