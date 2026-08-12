import { memo, useState } from 'react'
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  SquareTerminal,
  Users,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Spinner } from '../../ui/spinner'
import { Collapse } from '../../motion/collapse'
import type { Block } from '../../../state/blocks'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/**
 * Humanized tool rows: a verb, the thing it acted on, and a formatted
 * expansion per tool — never raw JSON. File-editing tools render through
 * EditCard instead (Transcript routes them).
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const input = (b: ToolBlock): Record<string, unknown> =>
  b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}

// eslint-disable-next-line no-control-regex -- ESC is the point: strip ANSI color codes
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

/** Cap what we render; full output stays in the event log. */
function capped(s: string, max = 20_000): string {
  return s.length > max
    ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString()} more chars)`
    : s
}

interface Presentation {
  icon: LucideIcon
  /** verb while running / verb once done */
  doing: string
  done: string
  detail: string
}

function present(b: ToolBlock): Presentation {
  const i = input(b)
  const file = str(i.file_path) || str(i.path) || str(i.notebook_path)
  switch (b.name) {
    case 'Bash':
    case 'shell':
    case 'Shell':
      return { icon: SquareTerminal, doing: 'Running', done: 'Ran', detail: str(i.command) }
    case 'Read':
      return { icon: FileText, doing: 'Reading', done: 'Read', detail: file.split('/').pop() ?? '' }
    case 'Grep':
      return { icon: FolderSearch, doing: 'Searching', done: 'Searched', detail: str(i.pattern) }
    case 'Glob':
      return { icon: FolderSearch, doing: 'Matching', done: 'Matched', detail: str(i.pattern) }
    case 'WebFetch':
      return {
        icon: Globe,
        doing: 'Fetching',
        done: 'Fetched',
        detail: str(i.url).replace(/^https?:\/\//, '')
      }
    case 'WebSearch':
    case 'web_search':
      return { icon: Globe, doing: 'Searching', done: 'Searched', detail: str(i.query) }
    case 'Task':
      return { icon: Users, doing: 'Delegating', done: 'Delegated', detail: str(i.description) }
    case 'TodoWrite':
    case 'update_plan':
      return { icon: ListChecks, doing: 'Planning', done: 'Updated plan', detail: '' }
    default: {
      // MCP tools arrive as `server.tool`; show the tool, keep the server.
      const [server, tool] = b.name.includes('.') ? b.name.split(/\.(.+)/) : [null, b.name]
      const firstString = Object.values(i).find((v) => typeof v === 'string')
      return {
        icon: Wrench,
        doing: tool ?? b.name,
        done: tool ?? b.name,
        detail: server
          ? `${server}${firstString ? ` · ${str(firstString)}` : ''}`
          : str(firstString)
      }
    }
  }
}

/** Terminal-flavored expansion for command tools. */
function CommandBody({
  command,
  output,
  isError
}: {
  command: string
  output?: string
  isError?: boolean
}): React.JSX.Element {
  return (
    <div className="font-mono text-xs leading-5">
      <div className="flex gap-1.5 text-muted-foreground">
        <span className="select-none text-muted-foreground/50">$</span>
        <span className="whitespace-pre-wrap break-all text-foreground">{command}</span>
      </div>
      {output !== undefined && (
        <pre
          className={cn(
            'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-muted-foreground',
            isError && 'text-destructive'
          )}
        >
          {capped(stripAnsi(output)) || '(no output)'}
        </pre>
      )}
    </div>
  )
}

function TodoBody({ todos }: { todos: { content: string; status: string }[] }): React.JSX.Element {
  return (
    <ul className="space-y-1">
      {todos.map((t, n) => (
        <li key={n} className="flex items-start gap-2 text-xs leading-5">
          {t.status === 'completed' ? (
            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
          ) : t.status === 'in_progress' ? (
            <Spinner className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <span className={cn(t.status === 'completed' && 'text-muted-foreground')}>
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Fallback expansion: labeled values, monospace where it's content. */
function GenericBody({ block }: { block: ToolBlock }): React.JSX.Element {
  const entries = Object.entries(input(block)).filter(([, v]) => v !== undefined && v !== null)
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="text-[11px] font-medium text-muted-foreground/70">{k}</div>
          {typeof v === 'string' ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {capped(v, 4000)}
            </pre>
          ) : typeof v === 'number' || typeof v === 'boolean' ? (
            <span className="font-mono text-xs">{String(v)}</span>
          ) : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {capped(JSON.stringify(v, null, 2), 4000)}
            </pre>
          )}
        </div>
      ))}
      {block.output !== undefined && (
        <pre
          className={cn(
            'max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground',
            block.isError && 'text-destructive'
          )}
        >
          {capped(stripAnsi(block.output)) || '(no output)'}
        </pre>
      )}
    </div>
  )
}

function Body({ block }: { block: ToolBlock }): React.JSX.Element {
  const i = input(block)
  switch (block.name) {
    case 'Bash':
    case 'shell':
    case 'Shell':
      return <CommandBody command={str(i.command)} output={block.output} isError={block.isError} />
    case 'TodoWrite':
    case 'update_plan': {
      const raw = (i.todos ?? i.plan) as
        { content?: string; step?: string; status?: string }[] | undefined
      if (Array.isArray(raw)) {
        return (
          <TodoBody
            todos={raw.map((t) => ({
              content: t.content ?? t.step ?? '',
              status: t.status ?? 'pending'
            }))}
          />
        )
      }
      return <GenericBody block={block} />
    }
    case 'WebFetch':
    case 'WebSearch':
    case 'web_search': {
      const url = str(i.url)
      return (
        <div className="space-y-2">
          {url && (
            <a
              href={url}
              onClick={(e) => {
                e.preventDefault()
                window.open(url)
              }}
              className="block truncate text-xs text-primary hover:underline"
            >
              {url}
            </a>
          )}
          {block.output !== undefined && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {capped(stripAnsi(block.output))}
            </pre>
          )}
        </div>
      )
    }
    case 'Read':
    case 'Grep':
    case 'Glob':
      return (
        <div className="space-y-2">
          {(str(i.file_path) || str(i.path)) && (
            <div className="truncate font-mono text-[11px] text-muted-foreground/70">
              {str(i.file_path) || str(i.path)}
            </div>
          )}
          {block.output !== undefined && (
            <pre
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground',
                block.isError && 'text-destructive'
              )}
            >
              {capped(stripAnsi(block.output)) || '(no matches)'}
            </pre>
          )}
        </div>
      )
    default:
      return <GenericBody block={block} />
  }
}

export const ToolChip = memo(function ToolChip({ block }: { block: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = block.output === undefined
  const p = present(block)

  return (
    <div className="max-w-[95%]">
      {/* Lighter than edit cards on purpose — file changes carry the
          visual weight in a transcript, routine tool calls recede. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/50',
          block.isError && 'text-destructive'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90'
          )}
        />
        <p.icon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 text-xs text-muted-foreground">{running ? p.doing : p.done}</span>
        {p.detail && (
          <span className="truncate font-mono text-xs text-muted-foreground/60">{p.detail}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {block.subCount > 0 && (
            <span className="text-[11px] text-muted-foreground">{block.subCount} steps</span>
          )}
          {block.isError && <span className="text-[11px] text-destructive">failed</span>}
          {running ? (
            <Spinner className="size-3" />
          ) : (
            !block.isError && <Check className="size-3 text-muted-foreground/40" />
          )}
        </span>
      </button>
      <Collapse open={open}>
        <div className="mt-1 rounded-md border bg-card px-3 py-2">
          <Body block={block} />
        </div>
      </Collapse>
    </div>
  )
})
