import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'
import type { Block } from '../../state/blocks'
import { LoadingState } from '../bui/loading-state'
import { ApprovalCard } from './blocks/ApprovalCard'
import { EDIT_TOOLS, EditCard } from './blocks/EditCard'
import { MarkdownText } from './blocks/MarkdownText'
import { ThinkingBlock } from './blocks/ThinkingBlock'
import { ToolChip } from './blocks/ToolChip'
import { UserMessage } from './blocks/UserMessage'

/**
 * Virtualized transcript over the store's incrementally-folded blocks.
 * Rows are memoized; a streaming delta re-renders only the one block whose
 * object identity changed. User messages render as bordered fields
 * (Cursor-style), not colored bubbles.
 */

export const BlockRow = memo(function BlockRow({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'user':
      return <UserMessage block={block} />
    case 'assistant':
      return (
        <div className="text-[13px] leading-relaxed">
          <MarkdownText text={block.text} streaming={block.streaming} />
        </div>
      )
    case 'thinking':
      return (
        <ThinkingBlock text={block.text} streaming={block.streaming} thoughtMs={block.thoughtMs} />
      )
    case 'tool':
      return EDIT_TOOLS.has(block.name) ? <EditCard block={block} /> : <ToolChip block={block} />
    case 'approval':
      return <ApprovalCard block={block} />
    case 'error':
      return (
        <div className="rounded-md border border-destructive/40 px-3 py-2 text-[13px] text-destructive">
          {block.text}
        </div>
      )
  }
})

/** True while the last block is already visibly in motion — no extra
 *  indicator needed on top of it. */
function lastBlockActive(block: Block | undefined): boolean {
  if (!block) return false
  if ((block.kind === 'assistant' || block.kind === 'thinking') && block.streaming) return true
  if (block.kind === 'tool' && block.output === undefined) return true
  if (block.kind === 'approval' && !block.resolved) return true
  return false
}

export function Transcript({
  sessionId,
  className
}: {
  sessionId: string
  className?: string
}): React.JSX.Element {
  const blocks = useApp((s) => s.blocks[sessionId]) ?? []
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // Blocks present at mount are history — only later arrivals animate in.
  const initialCount = useRef(blocks.length)

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
  }, [sessionId])

  const last = blocks.at(-1)
  // The turn is underway but nothing on screen shows it yet (model hasn't
  // started streaming, or a tool just finished) — hold a live indicator.
  const working = (status === 'running' || status === 'starting') && !lastBlockActive(last)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [last, blocks.length, working])

  // New session selected: jump to the end.
  useLayoutEffect(() => {
    atBottomRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId])

  return (
    <div
      ref={scrollRef}
      className={cn('[overflow-anchor:none]', className ?? 'flex-1 overflow-y-auto select-text')}
    >
      <div
        className="relative mx-auto w-full max-w-3xl px-6"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const block = blocks[item.index]
          // Chrome rows (tools, thinking) cluster; prose and messages breathe.
          const dense = block.kind === 'tool' || block.kind === 'thinking'
          const fresh = item.index === blocks.length - 1 && blocks.length > initialCount.current
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute right-6 left-6"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <div
                className={cn(
                  dense ? 'py-1' : 'py-2.5',
                  fresh && 'animate-[block-in_180ms_cubic-bezier(0.16,1,0.3,1)]'
                )}
              >
                <BlockRow block={block} />
              </div>
            </div>
          )
        })}
      </div>
      {working && (
        <div className="mx-auto w-full max-w-3xl px-6 pb-3 animate-[block-in_180ms_cubic-bezier(0.16,1,0.3,1)]">
          <LoadingState />
        </div>
      )}
    </div>
  )
}
