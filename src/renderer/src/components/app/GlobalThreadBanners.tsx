import { useState } from 'react'
import { AlertTriangle, Pause } from 'lucide-react'
import { pausedRoots, recoveryRoots, useApp } from '../../state/store'
import { cn } from '../../lib/utils'

type BannerKind = 'recovery' | 'paused'

export function GlobalThreadBanners(): React.JSX.Element | null {
  const sessions = useApp((state) => state.sessions)
  const recovery = recoveryRoots(sessions)
  const paused = pausedRoots(sessions)
  const recoveryCount = recovery.length
  const pausedCount = paused.length
  const continueAllErrors = useApp((state) => state.continueAllErrors)
  const resumeAllPaused = useApp((state) => state.resumeAllPaused)
  const [busy, setBusy] = useState<BannerKind | null>(null)
  const [recoveryFailures, setRecoveryFailures] = useState<string[]>([])
  const [pauseFailures, setPauseFailures] = useState<string[]>([])

  if (recoveryCount === 0 && pausedCount === 0) return null

  const runRecovery = async (): Promise<void> => {
    if (busy) return
    setBusy('recovery')
    setRecoveryFailures([])
    try {
      const result = await continueAllErrors()
      setRecoveryFailures(result.failed.map((failure) => failure.sessionId))
    } catch {
      setRecoveryFailures(recovery.map((root) => root.id))
    } finally {
      setBusy(null)
    }
  }

  const runPaused = async (): Promise<void> => {
    if (busy) return
    setBusy('paused')
    setPauseFailures([])
    try {
      const result = await resumeAllPaused()
      setPauseFailures(result.failed.map((failure) => failure.sessionId))
    } catch {
      setPauseFailures(paused.map((root) => root.id))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="shrink-0" aria-label="Thread alerts" aria-live="polite">
      {recoveryCount > 0 && (
        <ThreadBanner
          kind="recovery"
          count={recoveryCount}
          failures={recovery.filter((root) => recoveryFailures.includes(root.id)).length}
          busy={busy === 'recovery'}
          disabled={busy !== null}
          onContinue={() => void runRecovery()}
        />
      )}
      {pausedCount > 0 && (
        <ThreadBanner
          kind="paused"
          count={pausedCount}
          failures={paused.filter((root) => pauseFailures.includes(root.id)).length}
          busy={busy === 'paused'}
          disabled={busy !== null}
          onContinue={() => void runPaused()}
        />
      )}
    </section>
  )
}

function ThreadBanner({
  kind,
  count,
  failures,
  busy,
  disabled,
  onContinue
}: {
  kind: BannerKind
  count: number
  failures: number
  busy: boolean
  disabled: boolean
  onContinue: () => void
}): React.JSX.Element {
  const recovery = kind === 'recovery'
  const Icon = recovery ? AlertTriangle : Pause
  const label = recovery
    ? `${count} ${count === 1 ? 'thread needs' : 'threads need'} recovery`
    : `${count} ${count === 1 ? 'thread' : 'threads'} paused`
  const failureLabel =
    failures > 0 ? `${failures} ${failures === 1 ? 'retry failed' : 'retries failed'}` : null

  return (
    <div
      role={recovery ? 'alert' : 'status'}
      className={cn(
        'flex min-h-8 items-center gap-2 border-t border-b px-3 py-1 text-xs',
        recovery
          ? 'border-destructive/20 bg-destructive/8 text-destructive dark:bg-destructive/12'
          : 'border-warning/20 bg-warning/8 text-warning dark:bg-warning/12'
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="font-medium">{label}</span>
      {failureLabel && <span className="text-current/75">{failureLabel}</span>}
      <button
        type="button"
        onClick={onContinue}
        disabled={disabled}
        className={cn(
          'ml-auto shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-60',
          recovery
            ? 'border-destructive/25 bg-destructive/10 hover:bg-destructive/18'
            : 'border-warning/25 bg-warning/10 hover:bg-warning/18'
        )}
      >
        {busy ? 'Continuing…' : 'Continue all'}
      </button>
    </div>
  )
}
