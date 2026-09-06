import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeftRight, ChevronRight, Repeat } from 'lucide-react'
import type { CommitInfo, MergeResult } from '@shared/domain'
import { client } from '../../lib/client'
import { onFileEvent } from '../../lib/file-events'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { timeAgo } from './bits'
import { Spinner } from '../ui/spinner'
import { StatefulButton, type ButtonState } from '../motion/button/stateful'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/**
 * The Branch rail: this checkout against a target branch — ahead/behind,
 * the files this branch changed since the merge base (click → diff vs
 * that base), the commits on each side — and the two moves: bring the
 * target in (merge or rebase) or land the branch on it. Conflicts never
 * leave a half-merged tree; the panel lists the files instead.
 */

type Outcome =
  | { kind: 'ok'; text: string }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'error'; text: string }

const targetKey = (projectId: string): string => `compare-target:${projectId}`
const MODE_KEY = 'compare-mode'

export function BranchPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const compare = useApp((s) => s.compare[projectId])
  const fetchCompare = useApp((s) => s.fetchCompare)
  const fetchChanges = useApp((s) => s.fetchChanges)
  const fetchGitLog = useApp((s) => s.fetchGitLog)
  const fetchBranches = useApp((s) => s.fetchBranches)
  const branchList = useApp((s) => (project ? s.branchLists[project.workspaceId] : undefined))
  const headSha = useApp((s) => s.gitLog[projectId]?.commits[0]?.sha)
  const openDiffSurface = useApp((s) => s.openDiffSurface)
  const buildRunning = useApp((s) => s.builds[projectId]?.run?.status === 'running')

  const [target, setTarget] = useState<string | null>(() =>
    localStorage.getItem(targetKey(projectId))
  )
  const [mode, setMode] = useState<'merge' | 'rebase'>(() =>
    localStorage.getItem(MODE_KEY) === 'rebase' ? 'rebase' : 'merge'
  )
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [updateState, setUpdateState] = useState<ButtonState>('idle')
  const [landState, setLandState] = useState<ButtonState>('idle')
  const [aheadOpen, setAheadOpen] = useState(false)
  const [behindOpen, setBehindOpen] = useState(false)

  const refresh = useCallback(
    async (t: string | null): Promise<void> => {
      try {
        const r = await fetchCompare(projectId, t ?? undefined)
        setError(null)
        if (!t) setTarget(r.target)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [projectId, fetchCompare]
  )

  // Keyed by projectId in the parent — state resets by construction.
  useEffect(() => {
    void refresh(target)
    if (project) void fetchBranches(project.workspaceId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount + target only
  }, [projectId, target])

  // Counts stay live: a commit moves HEAD; edits come as file events.
  useEffect(() => {
    void refresh(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSha])
  useEffect(() => {
    let timer: number | undefined
    return onFileEvent((e) => {
      if (e.projectId !== projectId) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(target), 800)
    })
  }, [projectId, target, refresh])

  const pick = (t: string): void => {
    localStorage.setItem(targetKey(projectId), t)
    setOutcome(null)
    setTarget(t)
  }
  const flipMode = (): void => {
    const next = mode === 'merge' ? 'rebase' : 'merge'
    localStorage.setItem(MODE_KEY, next)
    setMode(next)
  }

  const current = project?.branch ?? branchList?.current ?? null
  const options = useMemo(() => {
    const locals = (branchList?.locals ?? []).filter((b) => b !== current)
    const remotes = branchList?.remotes ?? []
    const all = [...locals, ...remotes]
    if (target && !all.includes(target)) all.unshift(target)
    return all
  }, [branchList, current, target])
  const isLocal = !!target && (branchList?.locals ?? []).includes(target)

  const settle = async (): Promise<void> => {
    await Promise.all([refresh(target), fetchChanges(projectId), fetchGitLog(projectId)])
  }

  const act = async (
    setState: (s: ButtonState) => void,
    op: () => Promise<MergeResult>,
    okText: (r: Extract<MergeResult, { ok: true }>) => string
  ): Promise<void> => {
    setState('loading')
    setOutcome(null)
    try {
      const r = await op()
      if (r.ok) {
        setOutcome({ kind: 'ok', text: okText(r) })
        setState('success')
      } else {
        setOutcome({ kind: 'conflicts', files: r.conflicts })
        setState('error')
      }
    } catch (err) {
      setOutcome({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      setState('error')
    }
    await settle()
    setTimeout(() => setState('idle'), 1500)
  }

  // Button labels animate letter by letter, so they cannot truncate:
  // keep them short and clip long branch names by hand.
  const short = (b: string): string => {
    const name = b.replace(/^origin\//, '')
    return name.length > 14 ? `${name.slice(0, 13)}…` : name
  }
  const update = (): Promise<void> =>
    act(
      setUpdateState,
      () => client.request<MergeResult>('project.mergeFrom', { projectId, target, mode }),
      (r) =>
        mode === 'rebase'
          ? `Rebased onto ${target} · ${r.sha.slice(0, 7)}`
          : `${r.fastForward ? 'Fast-forwarded' : 'Merged'} · ${r.sha.slice(0, 7)}`
    )
  const land = (): Promise<void> =>
    act(
      setLandState,
      () => client.request<MergeResult>('project.mergeInto', { projectId, target }),
      (r) =>
        `${r.fastForward ? 'Fast-forwarded' : 'Merged into'} ${target} · ${r.sha.slice(0, 7)}${
          r.where ? ` · in ${r.where.replace(/^\/Users\/[^/]+/, '~')}` : ''
        }`
    )

  const busy = updateState === 'loading' || landState === 'loading' || buildRunning
  const ahead = compare?.ahead ?? 0
  const behind = compare?.behind ?? 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-4 pb-2 text-[11px]">
        <span className="min-w-0 truncate font-medium" title={current ?? undefined}>
          {current ?? '—'}
        </span>
        <ArrowLeftRight className="size-3 shrink-0 text-muted-foreground/50" />
        <Select value={target ?? ''} onValueChange={pick}>
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1 border-transparent bg-transparent px-1 font-mono text-[11px] shadow-none hover:bg-accent/60"
          >
            <SelectValue placeholder="target" />
          </SelectTrigger>
          <SelectContent>
            {options.map((b) => (
              <SelectItem key={b} value={b} className="font-mono text-[12px]">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {compare && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            ↑{ahead} ↓{behind}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <StatefulButton
          size="sm"
          variant="secondary"
          state={updateState}
          disabled={busy || !target || behind === 0}
          loadingText={mode === 'rebase' ? 'Rebasing' : 'Merging'}
          successText="Done"
          errorText="Stopped"
          onClick={() => void update()}
          className="h-7 shrink-0 px-3 text-xs"
          title={
            target
              ? mode === 'rebase'
                ? `Rebase ${current ?? 'this branch'} onto ${target}`
                : `Merge ${target} into ${current ?? 'this branch'}`
              : undefined
          }
        >
          {mode === 'rebase' ? 'Rebase' : 'Update'}
        </StatefulButton>
        <button
          onClick={flipMode}
          disabled={busy}
          title={mode === 'merge' ? 'Switch to rebase' : 'Switch to merge'}
          aria-label={mode === 'merge' ? 'Switch to rebase' : 'Switch to merge'}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Repeat className="size-3.5" />
        </button>
        <StatefulButton
          size="sm"
          variant="primary"
          state={landState}
          disabled={busy || !isLocal || ahead === 0}
          loadingText="Merging"
          successText="Merged"
          errorText="Stopped"
          onClick={() => void land()}
          className="h-7 min-w-0 flex-1 text-xs"
          title={
            !target
              ? undefined
              : !isLocal
                ? 'Merging into a remote branch needs a local one'
                : `Merge ${current ?? 'this branch'} into ${target}`
          }
        >
          Merge into {target ? short(target) : '…'}
        </StatefulButton>
      </div>

      {(outcome || error) && (
        <div className="shrink-0 px-4 pb-2 text-[11px] leading-snug">
          {outcome?.kind === 'ok' && <p className="text-muted-foreground">{outcome.text}</p>}
          {outcome?.kind === 'conflicts' && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
              <p className="text-destructive">
                Conflicts in {outcome.files.length} {outcome.files.length === 1 ? 'file' : 'files'}{' '}
                · nothing changed
              </p>
              <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10.5px] text-destructive/80">
                {outcome.files.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {outcome?.kind === 'error' && (
            <p className="break-words text-destructive">{outcome.text}</p>
          )}
          {!outcome && error && <p className="break-words text-destructive">{error}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!compare && !error ? (
          <div className="flex h-16 items-center justify-center">
            <Spinner className="size-3.5 text-muted-foreground" />
          </div>
        ) : compare && compare.files.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
            {ahead === 0 && behind === 0
              ? `Up to date with ${compare.target}`
              : `No file differs from ${compare.target}`}
          </p>
        ) : (
          compare?.files.map((c) => (
            <motion.button
              key={c.path}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              disabled={c.status === 'deleted'}
              onClick={() =>
                openDiffSurface(projectId, c.path, {
                  ref: compare.mergeBase,
                  label: short(compare.target)
                })
              }
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 active:scale-[0.99] disabled:active:scale-100"
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
                {c.status === 'added' ? (
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

      {compare && (ahead > 0 || behind > 0) && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border/60 px-4 py-1.5">
          <CommitList
            label={`${ahead} ahead`}
            commits={compare.ours}
            open={aheadOpen}
            onToggle={() => setAheadOpen(!aheadOpen)}
          />
          <CommitList
            label={`${behind} behind`}
            commits={compare.theirs}
            open={behindOpen}
            onToggle={() => setBehindOpen(!behindOpen)}
          />
        </div>
      )}
    </div>
  )
}

function CommitList({
  label,
  commits,
  open,
  onToggle
}: {
  label: string
  commits: CommitInfo[]
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  if (commits.length === 0) return null
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex h-6 w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="tabular-nums">{label}</span>
      </button>
      {open &&
        commits.map((c) => (
          <div key={c.sha} className="flex items-baseline gap-2 py-1 pl-4">
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
              {c.sha.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px]" title={c.subject}>
              {c.subject}
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
              {timeAgo(c.authoredAt)}
            </span>
          </div>
        ))}
    </div>
  )
}
