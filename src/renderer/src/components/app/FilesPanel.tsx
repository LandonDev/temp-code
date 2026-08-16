import { useEffect, useRef, useState } from 'react'
import { useTree } from '@headless-tree/react'
import { asyncDataLoaderFeature, selectionFeature } from '@headless-tree/core'
import { FileCode2, FolderOpen, FolderPlus, FilePlus2, Pencil, Trash2, Eye } from 'lucide-react'
import type { FsEntry } from '@shared/domain'
import { client } from '../../lib/client'
import { onFileEvent } from '../../lib/file-events'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Tree, TreeItem, TreeItemLabel } from '../reui/tree'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

/**
 * The Files panel (docs/PLAN-3.md M11): a lazy tree over fs.list — one
 * level per expand, live through file-event pushes. Rows are quiet: type
 * glyph, name, nothing else. Click opens a file surface.
 */

interface NodeData {
  name: string
  kind: 'file' | 'dir'
}

type PendingAction =
  | { type: 'new-file' | 'new-folder'; dir: string }
  | { type: 'rename'; path: string; name: string }
  | { type: 'delete'; path: string; name: string }

// Tree item ids are project-relative paths; the root is '.' because
// headless-tree treats a '' id as missing.
const ROOT = '.'

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT

export function FilesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const openFileSurface = useApp((s) => s.openFileSurface)
  const [action, setAction] = useState<PendingAction | null>(null)
  // Item data cache: getChildren fills it, getItem reads it.
  const cacheRef = useRef(new Map<string, NodeData>())

  const tree = useTree<NodeData>({
    rootItemId: ROOT,
    initialState: { expandedItems: [ROOT] },
    getItemName: (item) => item.getItemData()?.name ?? '…',
    isItemFolder: (item) => item.getItemData()?.kind !== 'file',
    createLoadingItemData: () => ({ name: '…', kind: 'file' }),
    dataLoader: {
      getItem: (id) =>
        cacheRef.current.get(id) ?? {
          name: id.split('/').pop() ?? project?.name ?? '',
          kind: id === ROOT ? 'dir' : 'file'
        },
      getChildren: async (id) => {
        const entries = await client
          .request<FsEntry[]>('fs.list', { projectId, dir: id === ROOT ? '' : id })
          .catch(() => [])
        return entries.map((e) => {
          const childId = id === ROOT ? e.name : `${id}/${e.name}`
          cacheRef.current.set(childId, { name: e.name, kind: e.kind })
          return childId
        })
      }
    },
    indent: 14,
    features: [asyncDataLoaderFeature, selectionFeature]
  })

  // Live tree: a created/deleted path invalidates its parent's children.
  useEffect(() => {
    return onFileEvent((e) => {
      if (e.projectId !== projectId || e.kind === 'changed') return
      const dir = parentOf(e.path)
      const item = tree.getItems().find((i) => i.getId() === dir)
      if (item) void item.invalidateChildrenIds()
    })
  }, [projectId, tree])

  if (!project) return <div />

  const dirFor = (itemId: string, kind: NodeData['kind']): string => {
    const dir = kind === 'dir' ? itemId : parentOf(itemId)
    return dir === ROOT ? '' : dir
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <Tree tree={tree} indent={14} toggleIconType="chevron">
        {tree.getItems().map((item) => {
          const id = item.getId()
          if (id === ROOT) return null
          const data = item.getItemData()
          const isDir = item.isFolder()
          return (
            <ContextMenu key={id}>
              <ContextMenuTrigger asChild>
                {/* The open action lives on the label: TreeItem spreads
                    headless-tree's own getProps() last, which would clobber
                    an onClick passed to it. Single click opens (dbl-click
                    still works — opening is idempotent). */}
                <TreeItem item={item} className="not-last:pb-0">
                  <TreeItemLabel
                    item={item}
                    onClick={() => {
                      if (!isDir) openFileSurface(projectId, id, null)
                    }}
                    className="gap-1.5 rounded-md bg-transparent px-1.5 py-1 text-[13px] not-in-data-[folder=true]:ps-5 in-data-[selected=true]:bg-accent"
                  >
                    {!isDir && <FileCode2 className="size-3.5 shrink-0 text-muted-foreground/60" />}
                    <span className="truncate">{data?.name}</span>
                  </TreeItemLabel>
                </TreeItem>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onClick={() =>
                    setAction({ type: 'new-file', dir: dirFor(id, data?.kind ?? 'file') })
                  }
                >
                  <FilePlus2 className="size-3.5 text-muted-foreground" />
                  New file
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    setAction({ type: 'new-folder', dir: dirFor(id, data?.kind ?? 'file') })
                  }
                >
                  <FolderPlus className="size-3.5 text-muted-foreground" />
                  New folder
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setAction({ type: 'rename', path: id, name: data?.name ?? '' })}
                >
                  <Pencil className="size-3.5 text-muted-foreground" />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setAction({ type: 'delete', path: id, name: data?.name ?? '' })}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                  Delete
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => void window.api.revealInFinder(`${project.cwd}/${id}`)}
                >
                  <Eye className="size-3.5 text-muted-foreground" />
                  Reveal in Finder
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </Tree>
      {tree.getItems().length <= 1 && (
        <button
          onClick={() => setAction({ type: 'new-file', dir: '' })}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[12px] text-muted-foreground/70 hover:bg-accent/60"
        >
          <FolderOpen className="size-3.5" />
          Empty — new file
        </button>
      )}
      <ActionDialog
        key={action ? `${action.type}:${'path' in action ? action.path : action.dir}` : 'none'}
        projectId={projectId}
        action={action}
        onDone={() => setAction(null)}
      />
    </div>
  )
}

/** One small dialog for create/rename/delete — CRUD never sprawls onto
 *  the panel itself (CLAUDE.md rule 9). */
function ActionDialog({
  projectId,
  action,
  onDone
}: {
  projectId: string
  action: PendingAction | null
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState(action?.type === 'rename' ? action.name : '')
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (!action) return
    try {
      if (action.type === 'new-file' || action.type === 'new-folder') {
        const trimmed = name.trim()
        if (!trimmed) return
        await client.request('fs.create', {
          projectId,
          path: action.dir ? `${action.dir}/${trimmed}` : trimmed,
          kind: action.type === 'new-file' ? 'file' : 'dir'
        })
      } else if (action.type === 'rename') {
        const trimmed = name.trim()
        if (!trimmed || trimmed === action.name) {
          onDone()
          return
        }
        const dir = parentOf(action.path)
        await client.request('fs.rename', {
          projectId,
          path: action.path,
          to: dir ? `${dir}/${trimmed}` : trimmed
        })
      } else if (action.type === 'delete') {
        await client.request('fs.delete', { projectId, path: action.path })
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const titles: Record<PendingAction['type'], string> = {
    'new-file': 'New file',
    'new-folder': 'New folder',
    rename: 'Rename',
    delete: `Delete ${action?.type === 'delete' ? action.name : ''}?`
  }

  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="w-80">
        <DialogHeader>
          <DialogTitle className="text-sm">{action ? titles[action.type] : ''}</DialogTitle>
        </DialogHeader>
        {action?.type === 'delete' ? (
          <p className="text-[12px] text-muted-foreground">
            This deletes it from the working tree.
          </p>
        ) : (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
            placeholder={action?.type === 'new-folder' ? 'folder name' : 'file name'}
            className="h-8 text-[13px]"
          />
        )}
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onDone} className={cn('h-7 text-xs')}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={action?.type === 'delete' ? 'destructive' : 'default'}
            onClick={() => void run()}
            className="h-7 text-xs"
          >
            {action?.type === 'delete' ? 'Delete' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
