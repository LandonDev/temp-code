import { useEffect, useMemo, useRef } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'
import type { AgentEvent } from '@shared/events'
import { useApp } from '../../state/store'

/**
 * Renders the normalized event log. Deltas are folded into blocks here in
 * the renderer; the persisted log stays raw. Virtualization comes with the
 * Beautiful UI transcript pass (docs/PLAN.md Milestone 3).
 */

type Block =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'error'; text: string }

function fold(events: AgentEvent[]): Block[] {
  const blocks: Block[] = []
  const toolIdx = new Map<string, number>()
  for (const e of events) {
    const last = blocks.at(-1)
    switch (e.type) {
      case 'user-text':
        blocks.push({ kind: 'user', text: e.text })
        break
      case 'assistant-text':
        if (e.delta && last?.kind === 'assistant') last.text += e.text
        else if (!e.delta && last?.kind === 'assistant') last.text = e.text
        else blocks.push({ kind: 'assistant', text: e.text })
        break
      case 'thinking':
        if (e.delta && last?.kind === 'thinking') last.text += e.text
        else if (!e.delta && last?.kind === 'thinking') last.text = e.text
        else blocks.push({ kind: 'thinking', text: e.text })
        break
      case 'tool-call':
        toolIdx.set(e.callId, blocks.length)
        blocks.push({ kind: 'tool', name: e.name, input: e.input })
        break
      case 'tool-result': {
        const idx = toolIdx.get(e.callId)
        if (idx !== undefined) {
          const b = blocks[idx] as Extract<Block, { kind: 'tool' }>
          b.output = e.output
          b.isError = e.isError
        }
        break
      }
      case 'error':
        blocks.push({ kind: 'error', text: e.message })
        break
    }
  }
  return blocks
}

function ToolBlock({ block }: { block: Extract<Block, { kind: 'tool' }> }): React.JSX.Element {
  return (
    <details className="group rounded-md border bg-card text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-xs">{block.name}</span>
        {block.isError && <span className="text-xs text-destructive">failed</span>}
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        <pre className="overflow-x-auto text-xs text-muted-foreground">
          {JSON.stringify(block.input, null, 2)}
        </pre>
        {block.output !== undefined && (
          <pre className="max-h-64 overflow-auto text-xs">{block.output}</pre>
        )}
      </div>
    </details>
  )
}

export function Transcript(): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedId)
  const rows = useApp((s) => (selectedId ? s.events[selectedId] : undefined))
  const blocks = useMemo(() => fold((rows ?? []).map((r) => r.event)), [rows])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [blocks.length, blocks.at(-1)?.kind === 'assistant' ? blocks.at(-1) : null])

  if (!selectedId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a session
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 select-text">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'user':
            return (
              <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
                {b.text}
              </div>
            )
          case 'assistant':
            return (
              <div key={i} className="max-w-[95%] text-sm leading-relaxed whitespace-pre-wrap">
                {b.text}
              </div>
            )
          case 'thinking':
            return (
              <div key={i} className="max-w-[95%] text-sm whitespace-pre-wrap text-muted-foreground italic">
                {b.text}
              </div>
            )
          case 'tool':
            return <ToolBlock key={i} block={b} />
          case 'error':
            return (
              <div key={i} className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                {b.text}
              </div>
            )
        }
      })}
      <div ref={bottomRef} />
    </div>
  )
}
