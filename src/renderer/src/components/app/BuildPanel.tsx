import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BuildRun, EffectiveBuild } from '@shared/build'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { useNow } from '../../lib/useNow'
import { cn } from '../../lib/utils'
import { duration } from './bits'
import { FileRefMenu } from './blocks/FileRefMenu'
import { StatefulButton } from '../motion/button/stateful'

/**
 * The Build rail: one button that runs the project's build command in
 * its checkout, the log streaming live underneath, and the files the
 * build produced at the bottom (click → Finder). The command comes from
 * the project override, the workspace setting, or detection.
 */
export function BuildPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const build = useApp((s) => s.builds[projectId])
  const fetchBuildStatus = useApp((s) => s.fetchBuildStatus)
  const runBuild = useApp((s) => s.runBuild)
  const cancelBuild = useApp((s) => s.cancelBuild)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const workspaceId = useApp((s) => s.projects.find((p) => p.id === projectId)?.workspaceId)
  const [effective, setEffective] = useState<EffectiveBuild | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const run = build?.run ?? null
  const lines = build?.lines ?? []
  const running = run?.status === 'running'
  const now = useNow(running)

  useEffect(() => {
    void fetchBuildStatus(projectId)
    void client
      .request<EffectiveBuild | null>('build.effective', { projectId })
      .then(setEffective)
      .catch(() => setEffective(null))
  }, [projectId, fetchBuildStatus])

  const start = async (): Promise<void> => {
    setError(null)
    try {
      await runBuild(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <div className="min-w-0 flex-1 text-[11px] leading-4">
          {effective ? (
            <>
              <div className="truncate font-mono" title={effective.command}>
                {effective.command}
              </div>
              {effective.source !== 'project' && (
                <div className="text-[10.5px] text-muted-foreground/60">{effective.source}</div>
              )}
            </>
          ) : effective === null ? (
            <span className="text-muted-foreground/70">
              No build command yet ·{' '}
              <button
                onClick={() => workspaceId && setSettingsOpen(true, `ws:${workspaceId}`)}
                className="text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                set one
              </button>
            </span>
          ) : null}
        </div>
        {running && run && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {duration(now - run.startedAt)}
          </span>
        )}
        <StatefulButton
          size="sm"
          variant={running ? 'secondary' : 'primary'}
          disabled={!effective}
          onClick={() => void (running ? cancelBuild(projectId) : start())}
          className="h-7 shrink-0 text-xs"
        >
          {running ? 'Cancel' : 'Build'}
        </StatefulButton>
      </div>
      {error && (
        <p className="shrink-0 break-words px-4 pb-2 text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}
      <Log lines={lines} runId={run?.id ?? null} />
      {run && run.status !== 'running' && <StatusLine run={run} />}
      {run && run.outputs.length > 0 && <Outputs outputs={run.outputs} />}
    </div>
  )
}

/** Autoscrolls while the user sits at the bottom; scrolling up parks it,
 *  scrolling back down re-arms it. */
function Log({ lines, runId }: { lines: string[]; runId: string | null }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    if (stick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines.length, runId])
  return (
    <div
      ref={ref}
      onScroll={() => {
        const el = ref.current
        if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
    >
      {lines.length === 0 && !runId ? (
        <p className="py-6 text-center font-sans text-[11px] text-muted-foreground/60">
          No builds yet
        </p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {line}
          </div>
        ))
      )}
    </div>
  )
}

function StatusLine({ run }: { run: BuildRun }): React.JSX.Element {
  const took = duration((run.endedAt ?? Date.now()) - run.startedAt)
  return (
    <p
      className={cn(
        'shrink-0 border-t border-border/60 px-4 py-2 text-[11px] tabular-nums',
        run.status === 'ok' && 'text-muted-foreground',
        run.status === 'failed' && 'text-destructive',
        run.status === 'cancelled' && 'text-muted-foreground/70'
      )}
    >
      {run.status === 'ok'
        ? `Built in ${took}`
        : run.status === 'failed'
          ? `Failed${run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ''} · ${took}`
          : 'Cancelled'}
    </p>
  )
}

const fmtSize = (n: number): string =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`

function Outputs({ outputs }: { outputs: BuildRun['outputs'] }): React.JSX.Element {
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border/60 px-2 py-1.5">
      {outputs.map((o) => (
        <FileRefMenu key={o.abs} target={o.abs}>
          <button
            onClick={() => void window.api.revealInFinder(o.abs)}
            title={o.abs}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 active:scale-[0.99]"
          >
            <span className={cn('min-w-0 flex-1 truncate text-xs', !o.fresh && 'text-muted-foreground')}>
              {o.path.split('/').pop()}
              <span className="ml-1.5 text-[11px] text-muted-foreground/50">
                {o.path.includes('/') ? o.path.slice(0, o.path.lastIndexOf('/')) : ''}
              </span>
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">
              {o.fresh ? fmtSize(o.size) : 'not rebuilt'}
            </span>
          </button>
        </FileRefMenu>
      ))}
    </div>
  )
}
