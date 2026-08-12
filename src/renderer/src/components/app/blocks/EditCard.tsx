import { memo, useState } from 'react'
import { ChevronRight, FileDiff, FilePen, FilePlus2 } from 'lucide-react'
import { cn, displayPath } from '../../../lib/utils'
import { Spinner } from '../../ui/spinner'
import { Collapse } from '../../motion/collapse'
import { useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** Tool names that mean "the agent touched a file". */
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))

interface EditModel {
  path: string
  adds: number
  dels: number
  create: boolean
  /** old/new hunks for the inline preview (absent for apply_patch) */
  hunks: { old: string[]; new: string[] }[]
  /** additional files (apply_patch touches several) */
  extraPaths: string[]
}

function modelFor(b: ToolBlock): EditModel {
  const i = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
  const empty: EditModel = { path: '', adds: 0, dels: 0, create: false, hunks: [], extraPaths: [] }
  switch (b.name) {
    case 'Edit': {
      const oldL = lines(str(i.old_string))
      const newL = lines(str(i.new_string))
      return {
        ...empty,
        path: str(i.file_path),
        adds: newL.length,
        dels: oldL.length,
        hunks: [{ old: oldL, new: newL }]
      }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []
      const hunks = edits.map((e) => ({
        old: lines(str(e.old_string)),
        new: lines(str(e.new_string))
      }))
      return {
        ...empty,
        path: str(i.file_path),
        adds: hunks.reduce((n, h) => n + h.new.length, 0),
        dels: hunks.reduce((n, h) => n + h.old.length, 0),
        hunks
      }
    }
    case 'Write': {
      const content = lines(str(i.content))
      return {
        ...empty,
        path: str(i.file_path),
        adds: content.length,
        create: true,
        hunks: [{ old: [], new: content }]
      }
    }
    case 'NotebookEdit': {
      const src = lines(str(i.new_source))
      return {
        ...empty,
        path: str(i.notebook_path),
        adds: src.length,
        hunks: [{ old: [], new: src }]
      }
    }
    case 'apply_patch': {
      // codex fileChange: an array of {path, kind} or a path-keyed object.
      const paths = Array.isArray(b.input)
        ? (b.input as Record<string, unknown>[]).map((c) => str(c.path)).filter(Boolean)
        : Object.keys(i)
      return { ...empty, path: paths[0] ?? '', extraPaths: paths.slice(1) }
    }
    default:
      return empty
  }
}

function DiffPreview({ hunks }: { hunks: EditModel['hunks'] }): React.JSX.Element {
  return (
    <div className="max-h-72 overflow-auto font-mono text-[11px] leading-[1.5]">
      {hunks.map((h, n) => (
        <div key={n} className={cn(n > 0 && 'mt-2 border-t border-border/60 pt-2')}>
          {h.old.slice(0, 120).map((l, j) => (
            <div
              key={`o${j}`}
              className="bg-destructive/10 px-2 whitespace-pre-wrap break-all text-destructive"
            >
              − {l || ' '}
            </div>
          ))}
          {h.new.slice(0, 200).map((l, j) => (
            <div
              key={`n${j}`}
              className="bg-success/10 px-2 whitespace-pre-wrap break-all text-success"
            >
              + {l || ' '}
            </div>
          ))}
          {(h.old.length > 120 || h.new.length > 200) && (
            <div className="px-2 text-muted-foreground/60">…</div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * A file edit gets more visual weight than other tool calls: the file name
 * leads, the diffstat sits on the right, the row expands to the edit itself
 * and the trailing button opens the full working-tree diff in the rail.
 */
export const EditCard = memo(function EditCard({ block }: { block: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openFileRef = useApp((s) => s.openFileRef)
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const running = block.output === undefined
  const m = modelFor(block)
  const name = m.path.split('/').pop() ?? m.path
  const rawDir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : ''
  const shown = rawDir ? displayPath(rawDir, projectCwd) : ''
  const dir = shown === '.' ? '' : shown
  const allPaths = [m.path, ...m.extraPaths].filter(Boolean)

  return (
    <div className="max-w-[95%]">
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border bg-card pr-1.5 transition-colors hover:bg-accent/50',
          block.isError && 'border-destructive/40'
        )}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary">
            {m.create ? (
              <FilePlus2 className="size-3.5 text-foreground/70" />
            ) : (
              <FilePen className="size-3.5 text-foreground/70" />
            )}
          </span>
          <span className="min-w-0 truncate text-[13px]">
            <span className="font-medium">{name || block.name}</span>
            {dir && <span className="ml-1.5 text-xs text-muted-foreground/60">{dir}</span>}
            {m.extraPaths.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground/60">
                +{m.extraPaths.length} more
              </span>
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            {block.isError ? (
              <span className="text-[11px] text-destructive">failed</span>
            ) : (
              (m.adds > 0 || m.dels > 0) && (
                <span className="text-xs font-medium tabular-nums">
                  {m.adds > 0 && <span className="text-success">+{m.adds}</span>}{' '}
                  {m.dels > 0 && <span className="text-destructive">−{m.dels}</span>}
                </span>
              )
            )}
            {running && <Spinner className="size-3" />}
          </span>
        </button>
        {m.path && (
          <button
            onClick={() => openFileRef(m.path)}
            aria-label="Open diff in Changes"
            title="Open diff in Changes"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 opacity-0 transition hover:bg-accent hover:text-foreground active:scale-95 group-hover:opacity-100"
          >
            <FileDiff className="size-3.5" />
          </button>
        )}
      </div>
      <Collapse open={open}>
        <div className="mt-1 rounded-md border bg-card py-1.5">
          {m.hunks.length > 0 ? (
            <DiffPreview hunks={m.hunks} />
          ) : (
            <div className="space-y-1 px-3 py-1">
              {allPaths.map((p) => (
                <button
                  key={p}
                  onClick={() => openFileRef(p)}
                  className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {p}
                </button>
              ))}
              {block.output !== undefined && block.isError && (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-destructive">
                  {block.output}
                </pre>
              )}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
})
