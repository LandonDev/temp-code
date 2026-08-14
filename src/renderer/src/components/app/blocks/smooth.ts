import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Smooth streaming reveal — the harness delivers text in coarse chunks
 * (whole sentences at a time over the WS), which looks glitchy if each
 * chunk commits at once. This hook decouples what ARRIVED from what is
 * SHOWN: arrivals land in a buffer and the shown length glides toward the
 * live end every frame, so text flows out at a steady, continuous pace
 * regardless of chunk size.
 *
 * - Exponential catch-up: each frame reveals remaining × (1 − e^(−dt/τ)),
 *   τ 320ms while streaming — big chunks drain fast at first, then ease.
 * - A floor of 25 chars/s so the tail never stalls between chunks.
 * - Lag cap 900 chars: a torrent (pasted code) skips ahead rather than
 *   replaying at length.
 * - Stream end drains at τ 90ms — a quick finish, not a snap.
 * - Paints at most every 33ms so markdown re-parses at ~30fps, not 60.
 * - A non-append rewrite (final text differing from the deltas) snaps.
 * - Mount baselines to the full text: history and re-attach show instantly;
 *   only text that arrives while we watch animates.
 */

const TAU_STREAM_MS = 320
const TAU_DRAIN_MS = 90
const FLOOR_CPS = 25
const MAX_LAG = 900
const PAINT_EVERY_MS = 33

interface Reveal {
  pos: number // fractional revealed length
  prev: string
  target: string
  live: boolean | undefined
  raf: number
  lastFrame: number
  lastPaint: number
}

export function useSmoothText(text: string, streaming: boolean | undefined): string {
  const [shown, setShown] = useState(text.length)
  const st = useRef<Reveal>({
    pos: text.length,
    prev: text,
    target: text,
    live: streaming,
    raf: 0,
    lastFrame: 0,
    lastPaint: 0
  })

  useLayoutEffect(() => {
    const s = st.current
    s.live = streaming
    s.target = text
    // Non-append rewrite: the already-revealed prefix changed under us.
    const whole = Math.floor(s.pos)
    if (text.slice(0, whole) !== s.prev.slice(0, whole)) {
      s.pos = text.length
      setShown(text.length)
    }
    s.prev = text
    if (s.pos >= text.length) return
    s.lastFrame = performance.now()
    const tick = (now: number): void => {
      s.raf = 0
      const dt = Math.min(now - s.lastFrame, 100)
      s.lastFrame = now
      const end = s.target.length
      const remaining = end - s.pos
      if (remaining <= 0) return
      const tau = s.live ? TAU_STREAM_MS : TAU_DRAIN_MS
      const step = Math.max(remaining * (1 - Math.exp(-dt / tau)), (dt * FLOOR_CPS) / 1000)
      s.pos = Math.min(end, s.pos + step)
      if (end - s.pos > MAX_LAG) s.pos = end - MAX_LAG
      if (s.pos >= end) {
        s.lastPaint = now
        setShown(end)
        return
      }
      if (now - s.lastPaint >= PAINT_EVERY_MS) {
        s.lastPaint = now
        setShown(Math.floor(s.pos))
      }
      s.raf = requestAnimationFrame(tick)
    }
    s.raf = requestAnimationFrame(tick)
    return () => {
      if (s.raf) {
        cancelAnimationFrame(s.raf)
        s.raf = 0
      }
    }
  }, [text, streaming])

  return shown >= text.length ? text : text.slice(0, shown)
}
