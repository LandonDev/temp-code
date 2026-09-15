import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight, X } from './icons'
import { LAYER } from '../lib/layers'
import { readAttachment } from '../lib/tcserver/commands'
import { Spinner } from '../surfaces/threads/bits'

/** An image the lightbox can show: either an in-memory URL (composer
 *  previews) or an attachment path fetched on demand (transcript thumbs). */
export type LightboxItem = { name: string; src?: string; path?: string }

/** Image bytes fetched once per attachment path for the app's lifetime,
 *  shared with the transcript thumbs so the lightbox opens from cache. */
const imageCache = new Map<string, Promise<string | null>>()
export function imageDataFor(path: string): Promise<string | null> {
  let pending = imageCache.get(path)
  if (!pending) {
    pending = readAttachment(path).catch(() => null)
    imageCache.set(path, pending)
  }
  return pending
}

let state: { items: LightboxItem[]; index: number } | null = null
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((f) => f())
const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** Open the viewer on a group of images; arrows/keys move within the group. */
export function openLightbox(items: LightboxItem[], index = 0): void {
  if (items.length === 0) return
  state = { items, index: Math.max(0, Math.min(index, items.length - 1)) }
  emit()
}

/** The command map (lib/appCommands.ts) drives Escape / ← / → through these. */
export function isLightboxOpen(): boolean {
  return state !== null
}

export function stepLightbox(delta: number): void {
  step(delta)
}

export function closeLightbox(): void {
  close()
}

function step(delta: number): void {
  if (!state || state.items.length < 2) return
  const n = state.items.length
  state = { ...state, index: (state.index + delta + n) % n }
  emit()
}

function close(): void {
  state = null
  emit()
}

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
    void imageDataFor(item.path).then((url) => {
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
  const snap = useSyncExternalStore(subscribe, () => state)
  const reduce = useReducedMotion()
  const primary = useIsPrimaryHost()

  if (!primary) return null
  const many = (snap?.items.length ?? 0) > 1
  return (
    <AnimatePresence>
      {snap ? (
        <motion.div
          data-lightbox
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
          className="fixed inset-0 flex items-center justify-center bg-black/40"
          style={{ zIndex: LAYER.dialog + 5 }}
          onClick={close}
        >
          <motion.div
            key={snap.index}
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
            className="flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Slide item={snap.items[snap.index]!} />
          </motion.div>

          <button
            type="button"
            onClick={close}
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
                  step(-1)
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
                  step(1)
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
    </AnimatePresence>
  )
}
