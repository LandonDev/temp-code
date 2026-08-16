/**
 * The renderer end of the watcher spine (docs/PLAN-3.md M11): the store
 * feeds `file-event` pushes in here; open models, the Files tree, and the
 * Changes rail subscribe. A plain bus — deliberately no monaco imports, so
 * subscribing never drags the editor chunk into the main bundle.
 */

export interface FileEvent {
  projectId: string
  path: string
  kind: 'changed' | 'created' | 'deleted'
}

const listeners = new Set<(e: FileEvent) => void>()

export function onFileEvent(listener: (e: FileEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dispatchFileEvent(e: FileEvent): void {
  for (const l of listeners) l(e)
}

/** Autosave flush, callable from the store without importing the editor
 *  chunk: a no-op until the registry (models.ts) installs itself. */
let flusher: (() => Promise<void>) | null = null

export function registerFlusher(fn: () => Promise<void>): void {
  flusher = fn
}

export function flushAllBuffers(): Promise<void> {
  return flusher?.() ?? Promise.resolve()
}

// ── file-rename intelligence hook (docs/PLAN-4.md M17) ───────────────
// The editor chunk registers a workspace/willRenameFiles handler when
// loaded; the Files panel calls through this seam so renaming a file
// updates imports without the panel ever importing monaco.

type WillRename = (projectId: string, fromRel: string, toRel: string) => Promise<void>
let willRename: WillRename | null = null

export function registerWillRename(handler: WillRename): void {
  willRename = handler
}

/** Apply rename-driven edits (imports) before the actual fs.rename;
 *  no-op when the editor chunk (or the engine) isn't up. */
export async function applyWillRename(
  projectId: string,
  fromRel: string,
  toRel: string
): Promise<void> {
  await willRename?.(projectId, fromRel, toRel).catch(() => undefined)
}
