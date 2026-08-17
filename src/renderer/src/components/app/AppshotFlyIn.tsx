import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Attachment } from '@shared/events'
import { useApp } from '../../state/store'
import { client } from '../../lib/client'
import { EASE_OUT } from '../../lib/ease'

/**
 * Codex-style capture landing: the fresh appshot appears large over the app
 * with a camera flash, holds a beat, then shrinks into its composer chip.
 * Purely visual — the attachment is already staged in the store; the overlay
 * never takes pointer events.
 */

/** How long the full-size shot lingers before flying to the chip. */
const HOLD_MS = 620

export function AppshotFlyIn(): React.JSX.Element | null {
  const flash = useApp((s) => s.appshotFlash)
  const clear = useApp((s) => s.clearAppshotFlash)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (flash && reduced) clear()
  }, [flash, reduced, clear])
  if (!flash || reduced) return null
  // Keyed remount: a second capture mid-flight restarts the sequence clean.
  return <Fly key={flash.key} a={flash.a} onDone={clear} />
}

function Fly({ a, onDone }: { a: Attachment; onDone: () => void }): React.JSX.Element {
  const [img, setImg] = useState<{ src: string; w: number; h: number } | null>(null)
  const [fly, setFly] = useState<{ x: number; y: number; scale: number } | null>(null)

  useEffect(() => {
    let alive = true
    void client
      .request<string>('attachment.read', { path: a.path })
      .then((src) => {
        const probe = new Image()
        probe.onload = () =>
          alive && setImg({ src, w: probe.naturalWidth || 1, h: probe.naturalHeight || 1 })
        probe.onerror = () => alive && onDone()
        probe.src = src
      })
      .catch(() => onDone())
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per capture
  }, [a.path])

  // If the PNG never loads, the overlay must not sit there forever.
  useEffect(() => {
    if (img) return
    const t = setTimeout(onDone, 2_500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img])

  // Where the full-size shot sits: centered, a touch above the middle.
  const rect = useMemo(() => {
    if (!img) return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const k = Math.min((vw * 0.46) / img.w, (vh * 0.52) / img.h, 1)
    const w = img.w * k
    const h = img.h * k
    return { w, h, left: (vw - w) / 2, top: vh * 0.42 - h / 2 }
  }, [img])

  // After the hold, aim at this capture's chip in the composer (it's already
  // staged and rendered). No chip on screen → sink toward the bottom center.
  useEffect(() => {
    if (!rect) return
    const t = setTimeout(() => {
      const chip = document.querySelector(`[data-appshot-chip="${CSS.escape(a.path)}"]`)
      const c = chip?.getBoundingClientRect()
      const tcx = c ? c.left + c.width / 2 : window.innerWidth / 2
      const tcy = c ? c.top + c.height / 2 : window.innerHeight - 96
      setFly({
        x: tcx - (rect.left + rect.w / 2),
        y: tcy - (rect.top + rect.h / 2),
        scale: (c?.width ?? 96) / rect.w
      })
    }, HOLD_MS)
    return () => clearTimeout(t)
  }, [rect, a.path])

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]">
      <motion.div
        className="absolute inset-0 bg-white"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.3, 0] }}
        transition={{ duration: 0.4, times: [0, 0.12, 1], ease: 'easeOut' }}
      />
      {img && rect && (
        <motion.img
          src={img.src}
          alt={a.name}
          className="absolute rounded-xl border border-white/25 bg-background shadow-2xl"
          style={{ left: rect.left, top: rect.top, width: rect.w, height: rect.h }}
          initial={{ opacity: 0, scale: 1.045 }}
          animate={
            fly
              ? { x: fly.x, y: fly.y, scale: fly.scale, opacity: [1, 1, 0] }
              : { opacity: 1, scale: 1 }
          }
          transition={
            fly
              ? {
                  duration: 0.5,
                  ease: [0.32, 0.72, 0, 1],
                  opacity: { duration: 0.5, times: [0, 0.65, 1] }
                }
              : { duration: 0.22, ease: EASE_OUT }
          }
          onAnimationComplete={() => fly && onDone()}
        />
      )}
    </div>
  )
}
