import { memo, useEffect, useMemo, useState } from 'react'
import { Pause } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'
import { duration } from './bits'

/**
 * Zeron working indicator, in a permanently reserved 24px strip above the
 * composer — the composer never shifts when work starts or stops.
 * `Sending…` bridges send → turn-start; then the gradient matrix spinner
 * (750ms diagonal wave) + a rotating flavour word + elapsed `1m 32s`.
 */

/** The exact 20-word list, rotating every 7s, seeded per chat. */
const FLAVOUR_WORDS = [
  'Thinking',
  'Pondering',
  'Scheming',
  'Brewing',
  'Weaving',
  'Tinkering',
  'Musing',
  'Composing',
  'Sifting',
  'Untangling',
  'Distilling',
  'Sketching',
  'Plotting',
  'Riffing',
  'Combobulating',
  'Percolating',
  'Marinating',
  'Noodling',
  'Puzzling',
  'Conjuring'
] as const

const seedOf = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** 750ms diagonal gradient wave over a 3×3 matrix of cells — the app's one
 *  busy motif. Also runs at 2px in tool chips while a call's input loads.
 *  `tint` recolors the cells by what the thread is doing (activityKind):
 *  pink while investigating, green while editing, the busy gray while
 *  thinking — the color transition is eased so kind changes glide. */
export function MatrixSpinner({
  cell = 2.5,
  tint
}: {
  cell?: number
  tint?: 'think' | 'investigate' | 'edit' | null
}): React.JSX.Element {
  const tintClass =
    tint === 'investigate' ? 'bg-pink-400' : tint === 'edit' ? 'bg-success' : 'bg-busy'
  return (
    <span className="grid shrink-0 grid-cols-3" style={{ gap: cell * 0.6 }}>
      {Array.from({ length: 9 }, (_, n) => {
        const diag = (n % 3) + Math.floor(n / 3) // 0..4 down the diagonal
        return (
          <span
            key={n}
            className={cn('rounded-[0.5px] transition-colors duration-300', tintClass)}
            style={{
              width: cell,
              height: cell,
              animation: 'z-matrix 750ms linear infinite',
              animationDelay: `${diag * -150}ms`
            }}
          />
        )
      })}
    </span>
  )
}

export const WorkingStrip = memo(function WorkingStrip({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element {
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const activityKind = useApp((s) => s.sessions[sessionId]?.activityKind)
  const frozenActiveElapsed = useApp(
    (s) =>
      s.sessions[sessionId]?.treeFrozenActiveElapsed ??
      s.sessions[sessionId]?.frozenActiveElapsed ??
      0
  )
  const resume = useApp((s) => s.resume)
  const interrupt = useApp((s) => s.interrupt)
  const running = status === 'running'
  const starting = status === 'starting'
  const paused = status === 'paused'
  const active = running || starting
  const visible = active || paused

  // The whole working stretch, counted from its first message — the same
  // clock as the tab. busySince is server-stamped, so it survives steers,
  // queue drains, and leaving and re-entering the thread; the last user
  // message only backstops sessions from before the column existed.
  const turnStart = useApp((s) => {
    const since = s.sessions[sessionId]?.busySince
    if (since) return since
    const blocks = s.blocks[sessionId]
    if (!blocks) return undefined
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'user') return blocks[i].ts
    }
    return undefined
  })

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  const elapsed = paused
    ? Math.max(0, frozenActiveElapsed)
    : active
      ? Math.max(0, now - (turnStart ?? now))
      : 0

  // Flavour word: seeded per chat, rotates every 7s.
  const seed = useMemo(() => seedOf(sessionId), [sessionId])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick((n) => n + 1), 7000)
    return () => clearInterval(t)
  }, [running])
  const word = FLAVOUR_WORDS[(seed + tick) % FLAVOUR_WORDS.length]
  const [resumeBusy, setResumeBusy] = useState(false)
  const onResume = (): void => {
    if (resumeBusy) return
    setResumeBusy(true)
    resume(sessionId).finally(() => setResumeBusy(false))
  }

  return (
    <div
      className={cn(
        'mx-auto flex h-6 w-full max-w-[736px] shrink-0 items-center gap-2 px-6',
        paused && 'border-y border-warning/15 bg-warning/8'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground transition-opacity duration-150',
          visible ? 'opacity-100' : 'opacity-0',
          paused && 'w-full text-warning'
        )}
        aria-live="polite"
      >
        {paused ? (
          <>
            <Pause className="size-3 shrink-0 fill-current" strokeWidth={1.8} />
            <span className="font-medium">Paused</span>
            <span className="tabular-nums text-current/75">{duration(elapsed)}</span>
            <button
              type="button"
              onClick={() => void interrupt(sessionId)}
              className="ml-auto rounded-md border border-destructive/25 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={onResume}
              disabled={resumeBusy}
              className="rounded-md border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-warning/18 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {resumeBusy ? 'Continuing…' : 'Continue'}
            </button>
          </>
        ) : starting ? (
          <span>Sending…</span>
        ) : (
          <>
            <MatrixSpinner tint={activityKind} />
            <span>{word}</span>
            <span className="tabular-nums text-faint">{duration(elapsed)}</span>
          </>
        )}
      </div>
    </div>
  )
})
