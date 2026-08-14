import { memo, useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'

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

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** 750ms diagonal gradient wave over a 3×3 matrix of cells. */
function MatrixSpinner(): React.JSX.Element {
  return (
    <span className="grid shrink-0 grid-cols-3 gap-[1.5px]">
      {Array.from({ length: 9 }, (_, n) => {
        const diag = (n % 3) + Math.floor(n / 3) // 0..4 down the diagonal
        return (
          <span
            key={n}
            className="size-[2.5px] rounded-[0.5px] bg-busy"
            style={{
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
  const running = status === 'running'
  const starting = status === 'starting'
  const active = running || starting

  // Elapsed counts from the moment this strip saw the turn begin.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - t0), 1000)
    return () => clearInterval(t)
  }, [active])

  // Flavour word: seeded per chat, rotates every 7s.
  const seed = useMemo(() => seedOf(sessionId), [sessionId])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick((n) => n + 1), 7000)
    return () => clearInterval(t)
  }, [running])
  const word = FLAVOUR_WORDS[(seed + tick) % FLAVOUR_WORDS.length]

  return (
    <div className="mx-auto flex h-6 w-full max-w-[736px] shrink-0 items-center gap-2 px-6">
      <div
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground transition-opacity duration-150',
          active ? 'opacity-100' : 'opacity-0'
        )}
      >
        {starting ? (
          <span>Sending…</span>
        ) : (
          <>
            <MatrixSpinner />
            <span>{word}</span>
            <span className="tabular-nums text-faint">{formatElapsed(elapsed)}</span>
          </>
        )}
      </div>
    </div>
  )
})
