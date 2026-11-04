import { readAttachment } from '../lib/tcserver/commands'

/**
 * The lightbox's module store, apart from the component (Lightbox.tsx) so
 * the command map, the attachment chips and App.tsx can open, step and
 * close the viewer without pulling its chunk in (surfaces/chunks.ts
 * lightboxChunk): the component lands with the first thumbnail's hover.
 */

/** An image the lightbox can show: either an in-memory URL (composer
 *  previews) or an attachment path fetched on demand (transcript thumbs). */
export type LightboxItem = { environmentId: string; name: string; src?: string; path?: string }

/** Shared with transcript thumbs; count two bytes per data URL character. */
export const IMAGE_CACHE_BYTES = 64 * 1024 * 1024
const imageCache = new Map<string, string>()
const imageLoads = new Map<string, Promise<string | null>>()
let imageBytes = 0
export function imageDataFor(environmentId: string, path: string): Promise<string | null> {
  const key = JSON.stringify([environmentId, path])
  const cached = imageCache.get(key)
  if (cached !== undefined) {
    imageCache.delete(key)
    imageCache.set(key, cached)
    return Promise.resolve(cached)
  }
  const loading = imageLoads.get(key)
  if (loading) return loading
  const pending = readAttachment(environmentId, path).catch(() => null).then((data) => {
    if (data !== null && data.length * 2 <= IMAGE_CACHE_BYTES) {
      imageCache.set(key, data)
      imageBytes += data.length * 2
      while (imageBytes > IMAGE_CACHE_BYTES) {
        const oldest = imageCache.keys().next().value!
        imageBytes -= imageCache.get(oldest)!.length * 2
        imageCache.delete(oldest)
      }
    }
    return data
  }).finally(() => imageLoads.delete(key))
  imageLoads.set(key, pending)
  return pending
}

/** Where the viewer grows from and settles back to: the centre of the
 *  thumbnail that opened it, in the window's coordinates. */
export type LightboxOrigin = { x: number; y: number }

let state: { items: LightboxItem[]; index: number; origin?: LightboxOrigin } | null = null
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((f) => f())
const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** Open the viewer on a group of images; arrows/keys move within the group.
 *  `from` is the thumbnail's box: the viewer opens from it, and keeps that
 *  origin as it steps, so it closes back toward the image that was asked for. */
export function openLightbox(items: LightboxItem[], index = 0, from?: DOMRect): void {
  if (items.length === 0) return
  const origin = from ? { x: from.left + from.width / 2, y: from.top + from.height / 2 } : undefined
  state = { items, index: Math.max(0, Math.min(index, items.length - 1)), origin }
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

/** The component's subscription and snapshot (useSyncExternalStore). */
export function subscribeLightbox(f: () => void): () => void {
  return subscribe(f)
}
export function lightboxSnapshot(): { items: LightboxItem[]; index: number; origin?: LightboxOrigin } | null {
  return state
}
