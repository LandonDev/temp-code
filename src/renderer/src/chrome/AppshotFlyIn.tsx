import { sessionStore } from '../lib/tcserver/store'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { DUR, EASE_DRAWER, EASE_OUT } from '../lib/ease'
import { clearAppshotFlash, useAppshotFlash, type AppshotFlash } from '../lib/appshots'
import { readAttachment } from '../lib/tcserver/commands'

/** How long the capture holds centered before it flies to its chip. */
const HOLD_MS = 620

/**
 * A capture's arrival: the image rises in mid-screen, holds, then glides
 * into its chip in the composer. Mounted per pane; only the pane the
 * capture routed to plays it.
 */
export function AppshotFlyIn({ sessionId, active }: { sessionId: string; active: boolean }) {
  const flash = useAppshotFlash(sessionId)
  const environmentId = sessionStore.environmentOf(sessionId)
  if (!flash || !active || !environmentId) return null
  return <Flight key={flash.key} flash={flash} environmentId={environmentId} />
}

type Rect = { x: number; y: number; w: number; h: number }

/**
 * The capture's motion: it enters like a dialog (fade and scale from 0.95
 * over DUR.slow), then, once its chip is found, glides there on the drawer
 * curve and fades over the last third. Reduced motion fades in and out in
 * place over DUR.fast.
 */
export function flightMotion({ reduce, rect, target }: { reduce: boolean; rect: Rect; target: Rect | null }) {
  const enter = { duration: reduce ? DUR.fast : DUR.slow, ease: EASE_OUT }
  const initial = reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95 }
  if (!target) return { initial, animate: reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }, transition: enter }
  if (reduce) return { initial, animate: { opacity: 0 }, transition: { duration: DUR.fast, ease: EASE_OUT } }
  return {
    initial,
    animate: {
      x: target.x + target.w / 2 - (rect.x + rect.w / 2),
      y: target.y + target.h / 2 - (rect.y + rect.h / 2),
      scale: Math.max(target.w / rect.w, 0.04),
      opacity: [1, 1, 0]
    },
    transition: { duration: DUR.drawer, ease: EASE_DRAWER, opacity: { times: [0, 0.65, 1], duration: DUR.drawer } }
  }
}

function Flight({ flash, environmentId }: { flash: AppshotFlash; environmentId: string }) {
  const reduce = useReducedMotion()
  const [src, setSrc] = useState<string | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [target, setTarget] = useState<Rect | null>(null)
  const [done, setDone] = useState(false)
  const path = flash.attachment.path

  useEffect(() => {
    if (!path) return
    let live = true
    void readAttachment(environmentId, path)
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
  }, [environmentId, path])

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
      HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [src, rect, path])

  useEffect(() => {
    if (done) clearAppshotFlash(flash.key)
  }, [done, flash.key])

  if (done) return null

  const flight = rect ? flightMotion({ reduce: reduce === true, rect, target }) : null

  // Portaled: the pane sits under columns that contain layout, which would
  // box a fixed overlay into the pane.
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-(--layer-dialog)">
      {src && rect && flight ? (
        <motion.img
          src={src}
          alt=""
          className="absolute rounded-xl border border-border bg-background object-cover shadow-overlay"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          initial={flight.initial}
          animate={flight.animate}
          transition={flight.transition}
          onAnimationComplete={() => {
            if (target) setDone(true)
          }}
        />
      ) : null}
    </div>,
    document.body
  )
}
