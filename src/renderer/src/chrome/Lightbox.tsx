import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight, X } from './icons'
import { EASE_OUT, SPRING_PANEL } from '../lib/ease'
import { LAYER } from '../lib/layers'
import { Spinner } from '../surfaces/threads/bits'
import {
  closeLightbox,
  imageDataFor,
  lightboxSnapshot,
  stepLightbox,
  subscribeLightbox,
  type LightboxItem,
} from './lightboxStore'

// Every composer mounts a Lightbox; only the first one alive renders it,
// so split panes never stack two overlays.
const hosts: symbol[] = []
const hostSubs = new Set<() => void>()
const primaryHost = (): symbol | undefined => hosts[0]
function useIsPrimaryHost(): boolean {
  const [id] = useState(() => Symbol('lightbox-host'))
  useEffect(() => {
    hosts.push(id)
    hostSubs.forEach((f) => f())
    return () => {
      hosts.splice(hosts.indexOf(id), 1)
      hostSubs.forEach((f) => f())
    }
  }, [id])
  const primary = useSyncExternalStore((f) => {
    hostSubs.add(f)
    return () => hostSubs.delete(f)
  }, primaryHost)
  return primary === id
}

function Slide({ item }: { item: LightboxItem }) {
  const [src, setSrc] = useState<string | null>(item.src ?? null)
  useEffect(() => {
    if (item.src) {
      setSrc(item.src)
      return
    }
    setSrc(null)
    if (!item.path) return
    let alive = true
    void imageDataFor(item.environmentId, item.path).then((url) => {
      if (alive) setSrc(url)
    })
    return () => {
      alive = false
    }
  }, [item])
  if (!src) return <Spinner className="size-6 text-content/50" />
  return (
    <img
      src={src}
      alt={item.name}
      draggable={false}
      className="max-h-[calc(100vh-96px)] max-w-[calc(100vw-160px)] select-none rounded-lg object-contain shadow-2xl"
    />
  )
}

const ARROW =
  'pressable absolute grid size-7 place-items-center rounded-md text-content/70 hover:bg-content/10 hover:text-content'

/**
 * Full-window image viewer. Click-away, Escape, or the corner X closes;
 * chevrons and arrow keys move within the group.
 */
export function Lightbox() {
  const snap = useSyncExternalStore(subscribeLightbox, lightboxSnapshot)
  const reduce = useReducedMotion()
  const primary = useIsPrimaryHost()

  if (!primary) return null
  const many = (snap?.items.length ?? 0) > 1
  // Portaled: it lives inside the composer, under columns that contain
  // layout, and a fixed overlay there would be boxed into its column.
  return createPortal(
    <AnimatePresence>
      {snap ? (
        <motion.div
          data-lightbox
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } }}
          className="fixed inset-0 flex items-center justify-center bg-black/40"
          style={{ zIndex: LAYER.dialog + 5 }}
          onClick={closeLightbox}
        >
          <motion.div
            key={snap.index}
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: SPRING_PANEL }}
            className="flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Slide item={snap.items[snap.index]!} />
          </motion.div>

          <button
            type="button"
            onClick={closeLightbox}
            aria-label="Close preview"
            className="pressable absolute right-4 top-4 grid size-7 place-items-center rounded-md text-content/70 hover:bg-content/10 hover:text-content"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>

          {many ? (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  stepLightbox(-1)
                }}
                aria-label="Previous image"
                className={`${ARROW} left-4`}
              >
                <ChevronLeft className="size-5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  stepLightbox(1)
                }}
                aria-label="Next image"
                className={`${ARROW} right-4`}
              >
                <ChevronRight className="size-5" strokeWidth={1.75} />
              </button>
              <span className="absolute bottom-4 text-[12px] tabular-nums text-content/50">
                {snap.index + 1} / {snap.items.length}
              </span>
            </>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}
