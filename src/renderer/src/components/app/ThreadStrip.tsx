import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type { ThreadType } from '@shared/domain'
import type { ProviderId } from '@shared/catalog'
import { threadsOfProject, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Tabs, TabsList, TabsTrigger } from '../motion/tabs'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Button } from '../ui/button'
import { StatusDot, THREAD_GLYPHS, THREAD_LABELS } from './bits'

const TYPE_HINTS: Record<ThreadType, string> = {
  chat: 'Ask questions, explore the code',
  planning: 'Produce a plan document to implement from',
  implementation: 'Execute a task, todos in focus',
  orchestration: 'Spawn and direct subagents'
}

/**
 * Threads of the selected project as underline tabs (spring indicator),
 * plus the new-thread popover anchored to its + button.
 */
export function ThreadStrip(): React.JSX.Element | null {
  const projectId = useApp((s) => s.selectedProjectId)
  const sessions = useApp((s) => s.sessions)
  const selectedId = useApp((s) => s.selectedId)
  const select = useApp((s) => s.select)

  const threads = useMemo(() => threadsOfProject(sessions, projectId), [sessions, projectId])
  if (!projectId) return null

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-4">
      <Tabs
        value={selectedId ?? ''}
        onValueChange={(id) => void select(id)}
        variant="underline"
        className="min-w-0 self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        <TabsList className="h-full border-b-0">
          {threads.map((t) => {
            const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
            return (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-full min-h-0 gap-1.5 px-2.5 py-0 text-[13px] font-normal"
              >
                <Glyph className="size-[13px] opacity-60" />
                <span className="max-w-44 truncate">{t.title}</span>
                <StatusDot status={t.status} />
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>
      <NewThreadButton projectId={projectId} empty={threads.length === 0} />
    </div>
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
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const createThread = useApp((s) => s.createThread)
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ThreadType>('chat')
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [busy, setBusy] = useState(false)

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
        // Worktree implementation runs unattended safely.
        permission: type === 'implementation' && project?.mode === 'worktree' ? 'auto' : 'edits'
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
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95',
            empty && 'text-foreground'
          )}
        >
          <Plus className="size-4" />
          {empty && <span className="text-[13px]">New thread</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex flex-col gap-0.5">
          {(Object.keys(THREAD_LABELS) as ThreadType[]).map((t) => {
            const Glyph = THREAD_GLYPHS[t]
            return (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  'flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors active:scale-[0.99]',
                  type === t ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                <Glyph className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
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
            <SelectTrigger aria-label="Provider" className="h-7 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(catalog).map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
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
