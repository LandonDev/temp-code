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

/** Image bytes fetched once per attachment path for the app's lifetime,
 *  shared with the transcript thumbs so the lightbox opens from cache. */
const imageCache = new Map<string, Promise<string | null>>()
export function imageDataFor(environmentId: string, path: string): Promise<string | null> {
  const key = JSON.stringify([environmentId, path])
  let pending = imageCache.get(key)
  if (!pending) {
    pending = readAttachment(environmentId, path).catch(() => null)
    imageCache.set(key, pending)
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

/** The component's subscription and snapshot (useSyncExternalStore). */
export function subscribeLightbox(f: () => void): () => void {
  return subscribe(f)
}
export function lightboxSnapshot(): { items: LightboxItem[]; index: number } | null {
  return state
}
