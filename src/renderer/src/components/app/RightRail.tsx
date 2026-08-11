import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, FileDiff } from 'lucide-react'
import { threadsOfProject, useApp } from '../../state/store'
import { client } from '../../lib/client'
import { cn } from '../../lib/utils'
import { EASE_DRAWER } from '../../lib/ease'

/**
 * The right rail: Changes for now, a panel registry later (Files, Terminal
 * — docs/LAYOUT.md ADE ambitions). Files land with a spring as edits
 * happen; click one for its diff.
 */
export function RightRail(): React.JSX.Element {
  const open = useApp((s) => s.railOpen)
  const projectId = useApp((s) => s.selectedProjectId)
  const reduce = useReducedMotion()

  return (
    <AnimatePresence initial={false}>
      {open && projectId && (
        <motion.aside
          initial={reduce ? false : { width: 0, opacity: 0 }}
          animate={{ width: 288, opacity: 1 }}
          exit={reduce ? undefined : { width: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.32, ease: EASE_DRAWER }}
          className="shrink-0 overflow-hidden border-l border-border/60 bg-sidebar"
        >
          <ChangesPanel projectId={projectId} />
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function ChangesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const changes = useApp((s) => s.changes[projectId]) ?? []
  const fetchChanges = useApp((s) => s.fetchChanges)
  const sessions = useApp((s) => s.sessions)
  const [diffPath, setDiffPath] = useState<string | null>(null)

  const anyRunning = useMemo(
    () => threadsOfProject(sessions, projectId).some((t) => t.status === 'running'),
    [sessions, projectId]
  )

  useEffect(() => {
    void fetchChanges(projectId)
    // Refresh while an agent is working; edits show up as they land.
    const t = setInterval(() => void fetchChanges(projectId), anyRunning ? 3000 : 15000)
    return () => clearInterval(t)
  }, [projectId, anyRunning, fetchChanges])

  useEffect(() => setDiffPath(null), [projectId])

  if (diffPath) {
    return <DiffView projectId={projectId} path={diffPath} onBack={() => setDiffPath(null)} />
  }

  return (
    <div className="flex h-full w-72 flex-col">
      <div className="titlebar-drag flex h-11 shrink-0 items-center px-4">
        <span className="text-xs font-medium text-muted-foreground">
          Changes{changes.length > 0 && ` · ${changes.length}`}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {changes.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
            No changes in the working tree
          </p>
        ) : (
          changes.map((c) => (
            <motion.button
              key={c.path}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => setDiffPath(c.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 active:scale-[0.99]"
            >
              <FileDiff className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs',
                  c.status === 'deleted' && 'line-through text-muted-foreground'
                )}
                title={c.path}
              >
                {c.path.split('/').pop()}
                <span className="ml-1.5 text-[11px] text-muted-foreground/50">
                  {c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums">
                {c.status === 'untracked' ? (
                  <span className="text-success">new</span>
                ) : (
                  <>
                    <span className="text-success">+{c.adds}</span>{' '}
                    <span className="text-destructive">−{c.dels}</span>
                  </>
                )}
              </span>
            </motion.button>
          ))
        )}
      </div>
    </div>
  )
}

function DiffView({
  projectId,
  path,
  onBack
}: {
  projectId: string
  path: string
  onBack: () => void
}): React.JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void client
      .request<string>('project.diff', { projectId, path })
      .then((d) => alive && setDiff(d))
      .catch(() => alive && setDiff(''))
    return () => {
      alive = false
    }
  }, [projectId, path])

  return (
    <div className="flex h-full w-72 flex-col">
      <div className="titlebar-drag flex h-11 shrink-0 items-center gap-1.5 px-2">
        <button
          onClick={onBack}
          aria-label="Back to changes"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-90"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="truncate text-xs font-medium text-muted-foreground">{path.split('/').pop()}</span>
      </div>
      <div className="flex-1 overflow-auto select-text">
        {diff === null ? null : diff === '' ? (
          <p className="px-4 py-6 text-center text-[11px] text-muted-foreground/60">No diff available</p>
        ) : (
          <pre className="px-2 pb-4 font-mono text-[11px] leading-[1.5]">
            {diff.split('\n').map((line, i) => (
              <div
                key={i}
                className={cn(
                  'px-2',
                  line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
                  line.startsWith('-') && !line.startsWith('---') && 'bg-destructive/10 text-destructive',
                  (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) &&
                    'text-muted-foreground/60'
                )}
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}
