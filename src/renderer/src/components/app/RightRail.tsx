import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { EASE_DRAWER } from '../../lib/ease'
import { timeAgo } from './bits'
import { Checkbox } from '../ui/checkbox'
import { StatefulButton, type ButtonState } from '../motion/button/stateful'
import { FilesPanel } from './FilesPanel'

/**
 * The right rail (docs/PLAN-3.md M11/M12): a small panel registry —
 * Changes (now the commit surface) and Files. Push-driven off file-events;
 * clicking a changed file opens a diff surface in the strip.
 */
export function RightRail(): React.JSX.Element {
  const open = useApp((s) => s.railOpen)
  const projectId = useApp((s) => s.selectedProjectId)
  const panel = useApp((s) => s.railPanel)
  const setPanel = useApp((s) => s.setRailPanel)
  const changes = useApp((s) => (s.selectedProjectId ? s.changes[s.selectedProjectId] : undefined))
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
          <div className="flex h-full w-72 flex-col">
            <div className="titlebar-drag flex h-11 shrink-0 items-center gap-4 px-4">
              {(['changes', 'files'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPanel(p)}
                  className={cn(
                    'text-xs font-medium transition-colors',
                    panel === p ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {p === 'changes' ? (
                    <>Changes{(changes?.length ?? 0) > 0 && ` · ${changes!.length}`}</>
                  ) : (
                    'Files'
                  )}
                </button>
              ))}
            </div>
            {panel === 'changes' ? (
              <ChangesPanel key={projectId} projectId={projectId} />
            ) : (
              <FilesPanel key={projectId} projectId={projectId} />
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function ChangesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const changes = useApp((s) => s.changes[projectId]) ?? []
  const fetchChanges = useApp((s) => s.fetchChanges)
  const fetchGitLog = useApp((s) => s.fetchGitLog)
  const gitLog = useApp((s) => s.gitLog[projectId])
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const openDiffSurface = useApp((s) => s.openDiffSurface)
  const commitProject = useApp((s) => s.commitProject)
  const pushProject = useApp((s) => s.pushProject)
  // Unchecked, not checked: files arriving later default to on.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [commitState, setCommitState] = useState<ButtonState>('idle')
  const [pushState, setPushState] = useState<ButtonState>('idle')
  const [error, setError] = useState<string | null>(null)

  // Keyed by projectId in the parent, so per-project state resets by
  // construction; the effect only fetches. Push-driven from here on:
  // file-events invalidate the list (M12).
  useEffect(() => {
    void fetchChanges(projectId)
    void fetchGitLog(projectId)
  }, [projectId, fetchChanges, fetchGitLog])

  const included = useMemo(
    () => changes.filter((c) => !excluded.has(c.path)).map((c) => c.path),
    [changes, excluded]
  )

  const run = async (alsoPush: boolean): Promise<void> => {
    const msg = message.trim()
    if (!msg || included.length === 0) return
    const setState = alsoPush ? setPushState : setCommitState
    setState('loading')
    setError(null)
    try {
      // The checkbox list is the commit: a partial set commits exactly it.
      await commitProject(projectId, msg, included.length === changes.length ? undefined : included)
      if (alsoPush) await pushProject(projectId)
      setMessage('')
      setState('success')
      setTimeout(() => setState('idle'), 1500)
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setState('idle'), 2500)
    }
  }

  const ahead = gitLog?.ahead
  const busy = commitState === 'loading' || pushState === 'loading'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* meta: where this lands. Worktree isolation is the design; local
          mode says honestly where commits go. */}
      {project?.branch && (
        <div className="flex shrink-0 items-center gap-1.5 px-4 pb-2 text-[11px] text-muted-foreground/70">
          <span className="truncate">
            {project.mode === 'local'
              ? `commits go to ${project.branch} in your checkout`
              : project.branch}
          </span>
          {ahead !== null && ahead !== undefined && ahead > 0 && (
            <span className="shrink-0 tabular-nums text-muted-foreground">↑{ahead}</span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {changes.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
            No changes in the working tree
          </p>
        ) : (
          changes.map((c) => (
            <motion.div
              key={c.path}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
            >
              <Checkbox
                checked={!excluded.has(c.path)}
                onCheckedChange={(v) =>
                  setExcluded((prev) => {
                    const next = new Set(prev)
                    if (v) next.delete(c.path)
                    else next.add(c.path)
                    return next
                  })
                }
                aria-label={`Include ${c.path} in the commit`}
                className="size-3.5 shrink-0"
              />
              <button
                onClick={() => openDiffSurface(projectId, c.path)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left active:scale-[0.99]"
              >
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
              </button>
            </motion.div>
          ))
        )}
      </div>
      {/* the commit surface */}
      {changes.length > 0 && (
        <div className="shrink-0 border-t border-border/60 p-3">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(true)
              else if (e.key === 'Enter') void run(false)
            }}
            placeholder="Commit message"
            className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          />
          {error && (
            <p className="mt-1.5 break-words text-[11px] leading-snug text-destructive">{error}</p>
          )}
          <div className="mt-2 flex gap-1.5">
            <StatefulButton
              size="sm"
              variant="secondary"
              state={commitState}
              disabled={busy || !message.trim() || included.length === 0}
              loadingText="Committing"
              successText="Committed"
              errorText="Failed"
              onClick={() => void run(false)}
              className="h-7 flex-1 text-xs"
            >
              Commit
            </StatefulButton>
            <StatefulButton
              size="sm"
              variant="primary"
              state={pushState}
              disabled={busy || !message.trim() || included.length === 0}
              loadingText="Pushing"
              successText="Pushed"
              errorText="Failed"
              onClick={() => void run(true)}
              className="h-7 flex-1 text-xs"
            >
              Commit & push
            </StatefulButton>
          </div>
        </div>
      )}
      {/* quiet history */}
      {(gitLog?.commits.length ?? 0) > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border/60 px-4 py-2">
          <AnimatePresence initial={false}>
            {gitLog!.commits.slice(0, 8).map((c) => (
              <motion.div
                key={c.sha}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-baseline gap-2 py-1"
              >
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
                  {c.sha.slice(0, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px]" title={c.subject}>
                  {c.subject}
                </span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
                  {timeAgo(c.authoredAt)}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
