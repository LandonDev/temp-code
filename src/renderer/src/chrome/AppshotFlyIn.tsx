import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '../lib/ease'
import { useAppshotFlash, type AppshotFlash } from '../lib/appshots'
import { readAttachment } from '../lib/tcserver/commands'

/** How long the capture holds centered before it flies to its chip. */
const HOLD_MS = 620
const FLIGHT_EASE = [0.32, 0.72, 0, 1] as const

/**
 * A capture's arrival: a flash, the image held mid-screen, then a flight
 * into its chip in the composer. Mounted per pane; only the pane the
 * capture routed to plays it.
 */
export function AppshotFlyIn({ sessionId, active }: { sessionId: string; active: boolean }) {
  const flash = useAppshotFlash(sessionId)
  if (!flash || !active) return null
  return <Flight key={flash.key} flash={flash} />
}

type Rect = { x: number; y: number; w: number; h: number }

function Flight({ flash }: { flash: AppshotFlash }) {
  const reduce = useReducedMotion()
  const [src, setSrc] = useState<string | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [target, setTarget] = useState<Rect | null>(null)
  const [done, setDone] = useState(false)
  const path = flash.attachment.path

  useEffect(() => {
    if (!path) return
    let live = true
    void readAttachment(path)
      .then((data) => {
        if (!live) return
        const img = new Image()
        img.onload = () => {
          if (!live) return
          const maxW = window.innerWidth * 0.46
          const maxH = window.innerHeight * 0.52
          const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
          const w = Math.round(img.naturalWidth * scale)
          const h = Math.round(img.naturalHeight * scale)
          setRect({
            x: Math.round((window.innerWidth - w) / 2),
            y: Math.round(window.innerHeight * 0.42 - h / 2),
            w,
            h
          })
          setSrc(data)
        }
        img.onerror = () => {
          if (live) setDone(true)
        }
        img.src = data
      })
      .catch(() => {
        if (live) setDone(true)
      })
    const fallback = window.setTimeout(() => {
      if (live) setDone(true)
    }, 2500)
    return () => {
      live = false
      window.clearTimeout(fallback)
    }
  }, [path])

  useEffect(() => {
    if (!src || !rect) return
    const timer = window.setTimeout(
      () => {
        const chip = path
          ? document.querySelector<HTMLElement>(`[data-attachment-path="${CSS.escape(path)}"]`)
          : null
        const box = chip?.getBoundingClientRect()
        setTarget(
          box && box.width > 0
            ? { x: box.left, y: box.top, w: box.width, h: box.height }
            : { x: window.innerWidth / 2 - 48, y: window.innerHeight - 96, w: 96, h: 56 }
        )
      },
      reduce ? 0 : HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [src, rect, path, reduce])

  if (done) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]">
      {reduce ? null : (
        <motion.div
          className="absolute inset-0 bg-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.3, 0] }}
          transition={{ duration: 0.4, times: [0, 0.12, 1], ease: 'easeOut' }}
        />
      )}
      {src && rect ? (
        <motion.img
          src={src}
          alt=""
          className="absolute rounded-xl border border-content/20 bg-background-base object-cover shadow-2xl"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 1.045 }}
          animate={
            target
              ? {
                  x: target.x + target.w / 2 - (rect.x + rect.w / 2),
                  y: target.y + target.h / 2 - (rect.y + rect.h / 2),
                  scale: Math.max(target.w / rect.w, 0.04),
                  opacity: [1, 1, 0]
                }
              : { opacity: 1, scale: 1 }
          }
          transition={
            target
              ? reduce
                ? { duration: 0 }
                : {
                    duration: 0.5,
                    ease: FLIGHT_EASE,
                    opacity: { times: [0, 0.65, 1], duration: 0.5 }
                  }
              : { duration: 0.22, ease: EASE_OUT }
          }
          onAnimationComplete={() => {
            if (target) setDone(true)
          }}
        />
      ) : null}
    </div>
  )
}
