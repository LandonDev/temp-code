import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { client } from '../../lib/client'
import { Spinner } from '../ui/spinner'

/** An image the lightbox can show: either an in-memory data URL (composer
 *  previews) or an attachment path fetched on demand (transcript thumbs). */
export type LightboxItem = { name: string; src?: string; path?: string }

/** Full-image data URLs, fetched once per attachment path for the app's
 *  lifetime. Shared with the transcript thumbs so the lightbox opens from
 *  cache. */
const imageCache = new Map<string, Promise<string>>()
export function imageDataFor(path: string): Promise<string> {
  let p = imageCache.get(path)
  if (!p) {
    p = client.request<string>('attachment.read', { path })
    imageCache.set(path, p)
  }
  return p
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
  state = { items, index }
  emit()
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

function Slide({ item }: { item: LightboxItem }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(item.src ?? null)
  useEffect(() => {
    if (item.src) {
      setSrc(item.src)
      return
    }
    setSrc(null)
    let alive = true
    if (item.path)
      void imageDataFor(item.path)
        .then((url) => alive && setSrc(url))
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [item])
  if (!src) return <Spinner className="size-6 text-white/60" />
  return (
    <img
      src={src}
      alt={item.name}
      draggable={false}
      className="max-h-[calc(100vh-96px)] max-w-[calc(100vw-160px)] rounded-lg object-contain shadow-2xl select-none"
    />
  )
}

/**
 * Full-window image viewer, mounted once at the app root. Click-away, Esc,
 * or the corner X closes; chevrons and arrow keys move within the group.
 */
export function Lightbox(): React.JSX.Element {
  const snap = useSyncExternalStore(subscribe, () => state)
  const reduce = useReducedMotion()

  useEffect(() => {
    if (!snap) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [snap])

  const many = (snap?.items.length ?? 0) > 1
  return (
    <AnimatePresence>
      {snap && (
        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 supports-backdrop-filter:backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            key={snap.index}
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
            className="flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Slide item={snap.items[snap.index]} />
          </motion.div>

          <button
            onClick={close}
            aria-label="Close preview"
            className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <X className="size-5" />
          </button>

          {many && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  step(-1)
                }}
                aria-label="Previous image"
                className="absolute left-4 flex size-9 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  step(1)
                }}
                aria-label="Next image"
                className="absolute right-4 flex size-9 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <ChevronRight className="size-6" />
              </button>
              <span className="absolute bottom-4 text-[12px] tabular-nums text-white/60">
                {snap.index + 1} / {snap.items.length}
              </span>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
