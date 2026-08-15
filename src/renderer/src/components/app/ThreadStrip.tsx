import { useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Archive, ArchiveRestore, Plus } from 'lucide-react'
import type { ThreadType } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import type { ProviderId } from '@shared/catalog'
import { threadsOfProject, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { SPRING_LAYOUT } from '../../lib/ease'
import { Tabs, TabsList, TabsTrigger } from '../motion/tabs'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Button } from '../ui/button'
import { StatusDot, THREAD_GLYPHS, THREAD_LABELS, timeAgo } from './bits'

const TYPE_HINTS: Record<ThreadType, string> = {
  chat: 'Ask questions, explore the code',
  planning: 'Produce a plan document to implement from',
  implementation: 'Execute a task, todos in focus',
  orchestration: 'Spawn and direct subagents'
}

/**
 * Threads of the selected project as soft chip tabs — the active chip's
 * accent wash glides between tabs, chips slide closed when archived.
 * Right-click a tab to archive it; the shelf at the strip's end recovers
 * archived threads (Zeron: hidden, never deleted).
 */
export function ThreadStrip(): React.JSX.Element | null {
  const projectId = useApp((s) => s.selectedProjectId)
  const sessions = useApp((s) => s.sessions)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const reduce = useReducedMotion()

  const threads = useMemo(() => threadsOfProject(sessions, projectId), [sessions, projectId])
  const archived = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.projectId === projectId && !s.parentId && s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, projectId]
  )
  if (!projectId) return null

  const archive = (id: string): void => {
    // Archiving the open tab hands selection to its nearest neighbour.
    if (selectedId === id) {
      const rest = threads.filter((t) => t.id !== id)
      const at = threads.findIndex((t) => t.id === id)
      void select(rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id ?? null)
    }
    void setArchived(id, true)
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-4">
      <Tabs
        value={selectedId ?? ''}
        onValueChange={(id) => void select(id)}
        variant="soft"
        className="flex min-w-0 items-center self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        <TabsList className="h-full">
          <AnimatePresence initial={false} mode="popLayout">
            {threads.map((t) => {
              const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                  transition={SPRING_LAYOUT}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div>
                        <TabsTrigger
                          value={t.id}
                          className="h-[26px] min-h-0 gap-1.5 px-2.5 py-0 font-normal"
                        >
                          <Glyph className="size-[13px] opacity-60" />
                          <span className="max-w-44 truncate">{t.title}</span>
                          <StatusDot status={t.status} />
                        </TabsTrigger>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => archive(t.id)}>
                        <Archive className="size-3.5 text-muted-foreground" />
                        Archive
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </TabsList>
      </Tabs>
      <NewThreadButton projectId={projectId} empty={threads.length === 0} />
      <div className="flex-1" />
      <ArchivedShelf archived={archived} />
    </div>
  )
}

/** Recover archived threads: restore puts the tab back and opens it. */
function ArchivedShelf({ archived }: { archived: SessionMeta[] }): React.JSX.Element | null {
  const select = useApp((s) => s.select)
  const setArchived = useApp((s) => s.setArchived)
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()

  if (archived.length === 0) return null

  const restore = async (id: string): Promise<void> => {
    if (archived.length === 1) setOpen(false)
    await setArchived(id, false)
    await select(id)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Archived threads"
          title="Archived threads"
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95',
            open && 'bg-accent text-foreground'
          )}
        >
          <Archive className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 p-1">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/60">
          Archived
        </div>
        <AnimatePresence initial={false}>
          {archived.map((t) => {
            const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
            return (
              <motion.button
                key={t.id}
                layout
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={SPRING_LAYOUT}
                onClick={() => void restore(t.id)}
                className="group/arch flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border">
                  <Glyph className="size-3.5 text-muted-foreground/70" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{t.title}</span>
                  <span className="block text-[11px] text-muted-foreground/60">
                    {timeAgo(t.updatedAt)}
                  </span>
                </span>
                {/* settle-on-hover: the restore affordance appears with the row */}
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/arch:opacity-100">
                  <ArchiveRestore className="size-3.5" />
                  Restore
                </span>
              </motion.button>
            )
          })}
        </AnimatePresence>
      </PopoverContent>
    </Popover>
  )
}

function NewThreadButton({
  projectId,
  empty
}: {
  projectId: string
  empty: boolean
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const createThread = useApp((s) => s.createThread)
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ThreadType>('chat')
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [busy, setBusy] = useState(false)
  const reduce = useReducedMotion()

  if (!catalog) return <span />
  // Orchestration runs on the claude harness (the MCP toolset lives there).
  const effProvider: ProviderId = type === 'orchestration' ? 'claude' : provider
  const info = catalog[effProvider]

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      // Model/reasoning are per message (picked in the prompt bar); the
      // thread starts on the provider default.
      await createThread({
        projectId,
        threadType: type,
        provider: effProvider,
        model: info.defaultModel,
        agentType: type === 'orchestration' ? 'orchestrator' : 'implementer',
        // Every thread starts at 'edits'; escalation is a per-thread choice
        // in the prompt bar, never a silent default.
        permission: 'edits'
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="New thread"
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95',
            empty && 'text-foreground'
          )}
        >
          <Plus className="size-4" />
          {empty && <span className="text-[13px]">New thread</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-xl p-2">
        <div className="flex flex-col gap-0.5">
          {(Object.keys(THREAD_LABELS) as ThreadType[]).map((t) => {
            const Glyph = THREAD_GLYPHS[t]
            return (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  'relative flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left active:scale-[0.99]',
                  type !== t && 'hover:bg-accent/50'
                )}
              >
                {type === t && (
                  <motion.span
                    layoutId="new-thread-type"
                    transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    className="absolute inset-0 rounded-md bg-accent"
                  />
                )}
                <Glyph className="relative mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="relative min-w-0">
                  <span className="block text-[13px] font-medium">{THREAD_LABELS[t]}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {TYPE_HINTS[t]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex items-center gap-1.5 border-t border-border/60 pt-2">
          <Select
            value={effProvider}
            onValueChange={(v) => setProvider(v as ProviderId)}
            disabled={type === 'orchestration'}
          >
            <SelectTrigger aria-label="Provider" className="h-7 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(catalog).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={busy}
            onClick={() => void create()}
          >
            Create
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
