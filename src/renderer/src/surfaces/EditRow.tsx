import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { GitCompare, Pencil } from '../chrome/icons'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent } from '../components/ui/collapsible'
import { Skeleton } from '../components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { readTextFile } from '../lib/fs'
import { hostOfCwd } from '../lib/tcserver/projects'
import { resolveWorkspacePath } from '../lib/paths'
import type { OpenFileFn } from '../lib/search'
import type { Block } from '../lib/session'
import { sessionStore, useLiveEdits } from '../lib/tcserver/store'
import { diffChunk } from './chunks'
import { SurfaceSkeleton } from './SurfaceSkeleton'

// The diff body rides the diff chunk (surfaces/chunks.ts); the first opened edit card pulls it in.
const DiffBody = diffChunk.surface('DiffBody', <SurfaceSkeleton kind="diff" label="Loading diff" />)
import {
  addRanges,
  editDiff,
  locateHunks,
  parseUnifiedDiff,
  previewToRows,
  rowsFromHunks,
  type DiffRow,
  type EditDiff
} from './diffRows'
import { RenderCache, cacheKey } from '../lib/renderCache'
import { editModel } from './editModel'
import { editOpenKey, usePersistedOpen } from './editOpenState'
import { OmittedNote } from './ToolDetails'
import { useTranscriptSession } from './transcriptSession'
import { ActionLine } from './transcript/ActionLine'
import { actionOf } from './transcript/actionModel'
import { ToolGlyph } from './transcript/ToolGlyph'

const InlineEditor = lazy(() => import('./monaco/InlineEditor'))

/**
 * One file change as one action line: the verb ("Edited", "Created",
 * "Deleted"), the file's name, its +N / -N counts ticking while it streams.
 * The diff opens in place under the line on the caret only, never on its
 * own. A click on a numbered row swaps the diff for the editor at that line.
 */

/** The rows to show: the tool input's hunks located in the landed file
 *  once the call settles (and again after an inline save), the source's
 *  own numbering when it has one, else the server preview. */
/** Parsed diffs by their settled input object: the store keeps a block's
 *  input across remounts, so a second mount never re-splits the patch. */
const diffByInput = new WeakMap<object, EditDiff>()
/** Located rows by block and file, so a remount skips the file read. The
 *  stored input guards against a block whose input was replaced. */
const locatedCache = new RenderCache<{ input: unknown; rows: DiffRow[] }>(2000, 8_000_000)

function cachedEditDiff(block: Block): EditDiff {
  const input = block.tool?.input
  if (!input || typeof input !== 'object' || block.streaming) return editDiff(block)
  const hit = diffByInput.get(input)
  if (hit) return hit
  const diff = editDiff(block)
  diffByInput.set(input, diff)
  return diff
}

/** Rows straight from the call: numbered when the source numbers them,
 *  else in hunk order, else the server's preview. */
function useParsedDiff(block: Block): { diff: EditDiff; rows: DiffRow[] } {
  const input = block.tool?.input
  const name = block.tool?.name
  const preview = block.tool?.preview?.lines
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const diff = useMemo(() => cachedEditDiff(block), [input, name])
  const rows = useMemo(() => {
    if (diff.rows) return diff.rows
    if (diff.hunks.length > 0) return rowsFromHunks(diff.hunks)
    return previewToRows(Array.isArray(preview) ? preview : [])
  }, [diff, preview])
  return { diff, rows }
}

/** The hunks located in the landed file (their line numbers), read once
 *  the call settles and the body is wanted — a collapsed row never reads
 *  its file — and again after an inline save. Null until located. */
function useLocatedRows(
  environmentId: string,
  block: Block,
  diff: EditDiff,
  filePath: string | undefined,
  settled: boolean,
  refresh: number,
  wanted: boolean
): DiffRow[] | null {
  const input = block.tool?.input
  const locatedKey = filePath ? cacheKey(block.id, filePath) : undefined
  const [located, setLocated] = useState<{ gen: number; rows: DiffRow[] } | null>(() => {
    const hit = locatedKey ? locatedCache.get(locatedKey) : undefined
    return hit && hit.input === input ? { gen: 0, rows: hit.rows } : null
  })
  const wantsLocate =
    wanted &&
    diff.hunks.length > 0 &&
    settled &&
    !!filePath &&
    (!diff.rows || refresh > 0) &&
    !(located && refresh === 0)
  useEffect(() => {
    if (!wantsLocate || !filePath) return
    let alive = true
    readTextFile(environmentId, filePath)
      .then((content) => {
        if (!alive) return
        const rows = locateHunks(diff.hunks, content)
        setLocated({ gen: refresh, rows })
        if (locatedKey) locatedCache.set(locatedKey, { input, rows }, rows.length * 40)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, wantsLocate, filePath, refresh, diff])
  return useMemo(() => {
    if (located && (refresh > 0 ? located.gen === refresh : true)) {
      if (refresh > 0 || !diff.rows) return located.rows
    }
    return null
  }, [located, refresh, diff])
}

export function EditRow({
  block,
  cwd,
  onOpenFile
}: {
  block: Block
  cwd?: string
  onOpenFile?: OpenFileFn
}) {
  const m = editModel(block)
  const action = actionOf(block, cwd)
  const running = action.running
  const filePath = m.path ? resolveWorkspacePath(m.path, cwd) : undefined
  const sessionId = useTranscriptSession()
  const environmentId = (sessionId ? sessionStore.environmentOf(sessionId) : undefined) ?? hostOfCwd(filePath ?? cwd ?? '')

  // Editing in place: which line the editor opens at, and a bump after a
  // save so the diff re-locates in the file as it is now.
  const [editMode, setEditMode] = useState(false)
  const [editLine, setEditLine] = useState<number | undefined>()
  const [refresh, setRefresh] = useState(0)
  const { diff, rows: parsedRows } = useParsedDiff(block)

  // While the edit streams, the server's live diff for this file leads.
  const liveEdits = useLiveEdits(sessionId ?? '')
  const liveRec = useMemo(() => {
    if (!running || !m.path) return undefined
    const rel = m.path
    return (
      liveEdits[rel] ??
      Object.values(liveEdits).find((r) => rel.endsWith('/' + r.path) || r.path.endsWith('/' + rel))
    )
  }, [running, m.path, liveEdits])
  const liveRows = useMemo(
    () =>
      liveRec?.diff
        ? (parseUnifiedDiff(liveRec.diff, liveRec.kind === 'created').rows ?? null)
        : null,
    [liveRec]
  )
  // Remote profile: the diff's text stayed on the server; the row opens
  // onto a note and fetches it (the counts above come from the preview).
  const omitted = block.tool?.omitted
  const hasDiff =
    (running && liveRows ? liveRows : parsedRows).some((r) => r.type === 'add' || r.type === 'del') ||
    !!omitted

  // Opening is the caret's alone, remembered per session and call.
  const [userOpen, setUserOpen] = usePersistedOpen(editOpenKey(sessionId, block))
  const open = hasDiff && (editMode || !!userOpen)
  useEffect(() => {
    if (open && omitted && !omitted.loading && !omitted.failed) void sessionStore.loadRowBodies(block)
  }, [open, omitted, block])
  // The file read that numbers the hunks waits until the body is wanted.
  const located = useLocatedRows(environmentId, block, diff, filePath, !running, refresh, open)
  const rows = located ?? parsedRows
  const shownRows = running && liveRows ? liveRows : rows

  const startLine = block.tool?.preview?.startLine
  const openFile =
    filePath && onOpenFile
      ? () => onOpenFile(filePath, startLine ? { line: startLine } : undefined, { environmentId })
      : undefined
  const canEdit = !!filePath && !!cwd && !running && !m.remove && !omitted
  const editHere = (line?: number): void => {
    setEditLine(line ?? startLine)
    setEditMode(true)
    setUserOpen(true)
  }
  const label = [action.verb, action.object].filter(Boolean).join(' ')

  return (
    <div data-block={block.id} className="flex min-w-0 flex-col">
      <ActionLine
        glyph={<ToolGlyph action={action} block={block} />}
        verb={action.verb}
        object={action.object}
        title={action.title}
        label={label}
        onObject={openFile}
        objectLabel={openFile ? `Open ${action.object}` : undefined}
        adds={running ? (liveRec?.adds ?? m.adds) : m.adds}
        dels={running ? (liveRec?.dels ?? m.dels) : m.dels}
        ticking={running}
        open={open}
        onToggle={
          hasDiff
            ? () => {
                if (open) setEditMode(false)
                setUserOpen(!open)
              }
            : undefined
        }
      />
      <Collapsible open={open}>
        <CollapsibleContent>
          <div className="group/body relative pb-2">
            {editMode && filePath && cwd ? (
              <>
                <CornerButton label="Show diff" onClick={() => setEditMode(false)}>
                  <GitCompare strokeWidth={1.5} />
                </CornerButton>
                <Suspense fallback={<Skeleton className="h-80" />}>
                  <InlineEditor
                    path={filePath}
                    cwd={cwd}
                    line={editLine}
                    highlight={addRanges(rows)}
                    onSave={() => {
                      setEditMode(false)
                      setRefresh((n) => n + 1)
                    }}
                  />
                </Suspense>
              </>
            ) : (
              <>
                {canEdit ? (
                  <CornerButton label="Edit here" onClick={() => editHere()}>
                    <Pencil strokeWidth={1.5} />
                  </CornerButton>
                ) : null}
                {omitted ? (
                  <OmittedNote bytes={omitted.bytes} failed={!!omitted.failed} />
                ) : (
                  <DiffBody rows={shownRows} onEditAt={canEdit ? editHere : undefined} />
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** A ghost icon button at the body's top right, shown on hover and focus. */
function CornerButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            className="absolute right-0 top-0 z-10 text-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--dur-fast) ease-(--ease-out) group-hover/body:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
