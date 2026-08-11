import { memo, useState } from 'react'
import {
  ChevronRight,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Pencil,
  SquareTerminal,
  Users,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Spinner } from '../../ui/spinner'
import type { Block } from '../../../state/blocks'

type ToolBlock = Extract<Block, { kind: 'tool' }>

const ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  Read: FileText,
  Write: Pencil,
  Edit: Pencil,
  NotebookEdit: Pencil,
  Grep: FolderSearch,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Users,
  TodoWrite: ListChecks
}

/** One line the chip can show about the call without expanding it. */
function summarize(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Bash':
      return s(i.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return s(i.file_path)
    case 'Grep':
    case 'Glob':
      return s(i.pattern)
    case 'WebFetch':
      return s(i.url)
    case 'WebSearch':
      return s(i.query)
    case 'Task':
      return s(i.description)
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string')
      return s(first)
    }
  }
}

export const ToolChip = memo(function ToolChip({ block }: { block: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[block.name] ?? Wrench
  const running = block.output === undefined
  const summary = summarize(block.name, block.input)

  return (
    <div className="max-w-[95%]">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent/50',
          block.isError && 'border-destructive/40'
        )}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">{block.name}</span>
        {summary && (
          <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {block.subCount > 0 && (
            <span className="text-xs text-muted-foreground">{block.subCount} steps</span>
          )}
          {block.isError && <span className="text-xs text-destructive">failed</span>}
          {running && <Spinner className="size-3" />}
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-2 rounded-md border bg-card px-3 py-2">
          {block.input !== undefined && (
            <pre className="overflow-x-auto text-xs text-muted-foreground">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
          {block.output !== undefined && (
            <pre className={cn('max-h-64 overflow-auto text-xs', block.isError && 'text-destructive')}>
              {block.output || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})
