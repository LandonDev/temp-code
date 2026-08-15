import type { FsReadResult, ProjectMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { onFileEvent, registerFlusher } from '../../lib/file-events'
import { useApp } from '../../state/store'
import { languageForPath, monaco } from './monaco'

/**
 * The model registry (docs/PLAN-3.md M11): one buffer per file, keyed by
 * absolute path, shared by every surface that shows it. Disk is the source
 * of truth — this module's whole job is keeping buffers and disk
 * converging fast in both directions:
 *
 *  - keystrokes → debounced ~800 ms autosave (flush on switch/blur/⌘S);
 *  - agent/terminal writes → watcher event → diff-applied model edits
 *    (never setValue), so cursor, folds, and undo survive;
 *  - the ≤800 ms overlap → queue the reload behind the flush; a true
 *    concurrent write surfaces as a one-line conflict bar, never a modal.
 */

const AUTOSAVE_MS = 800

export interface FileState {
  pending: boolean
  /** 'external': disk changed while unsaved keystrokes were in flight;
   *  'deleted': the file vanished under an open buffer */
  conflict: 'external' | 'deleted' | null
}

/** Formatter hook (M14): installed by the LSP layer, applied pre-flush
 *  when format-on-save is enabled for the model's language. */
type SaveHook = (model: monaco.editor.ITextModel) => Promise<void>
let saveHook: SaveHook | null = null
export function registerSaveHook(hook: SaveHook): void {
  saveHook = hook
}

/** Post-save listeners (the LSP layer sends textDocument/didSave — jdtls
 *  runs its incremental build off it). */
const savedListeners = new Set<(model: monaco.editor.ITextModel) => void>()
export function onModelSaved(cb: (model: monaco.editor.ITextModel) => void): () => void {
  savedListeners.add(cb)
  return () => savedListeners.delete(cb)
}

interface Entry {
  key: string
  projectId: string
  relPath: string
  absPath: string
  model: monaco.editor.ITextModel
  refs: number
  /** what we believe the file on disk holds */
  diskText: string
  savedAltId: number
  timer: number | null
  flushing: Promise<void> | null
  queuedReload: boolean
  applyingExternal: boolean
  state: FileState
  stateListeners: Set<(s: FileState) => void>
  dispose: () => void
}

const entries = new Map<string, Entry>()
const byUri = new Map<string, Entry>()
const keyOf = (projectId: string, relPath: string): string => `${projectId}:${relPath}`

function setState(entry: Entry, patch: Partial<FileState>): void {
  entry.state = { ...entry.state, ...patch }
  for (const l of entry.stateListeners) l(entry.state)
  useApp.setState((s) => ({ fileStates: { ...s.fileStates, [entry.key]: entry.state } }))
}

// ── external reconciliation ──────────────────────────────────────────

/** Apply new disk content as a minimal single edit (common prefix/suffix
 *  trimmed) so cursor, scroll, folds, and the undo stack survive. */
function applyExternal(entry: Entry, next: string): void {
  const cur = entry.model.getValue()
  if (cur === next) return
  let start = 0
  const minLen = Math.min(cur.length, next.length)
  while (start < minLen && cur[start] === next[start]) start++
  let endCur = cur.length
  let endNext = next.length
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--
    endNext--
  }
  const from = entry.model.getPositionAt(start)
  const to = entry.model.getPositionAt(endCur)
  entry.applyingExternal = true
  try {
    entry.model.pushEditOperations(
      [],
      [
        {
          range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
          text: next.slice(start, endNext)
        }
      ],
      () => null
    )
  } finally {
    entry.applyingExternal = false
  }
  entry.savedAltId = entry.model.getAlternativeVersionId()
}

async function reloadFromDisk(entry: Entry): Promise<void> {
  let res: FsReadResult
  try {
    res = await client.request<FsReadResult>('fs.read', {
      projectId: entry.projectId,
      path: entry.relPath
    })
  } catch {
    return // vanished — the deleted event handles it
  }
  if (res.tooLarge) return
  entry.diskText = res.content
  applyExternal(entry, res.content)
  if (entry.state.conflict === 'external') setState(entry, { conflict: null })
}

onFileEvent((e) => {
  const entry = entries.get(keyOf(e.projectId, e.path))
  if (!entry) return
  if (e.kind === 'deleted') {
    setState(entry, { conflict: 'deleted' })
    return
  }
  if (entry.state.conflict === 'deleted') setState(entry, { conflict: null })
  if (entry.state.pending || entry.flushing) {
    // Unflushed keystrokes: the window is ≤800 ms — reload after the flush.
    entry.queuedReload = true
    return
  }
  void reloadFromDisk(entry)
})

// ── autosave ─────────────────────────────────────────────────────────

async function flush(entry: Entry): Promise<void> {
  if (entry.flushing) return entry.flushing
  if (entry.model.getAlternativeVersionId() === entry.savedAltId) {
    if (entry.state.pending) setState(entry, { pending: false })
    return
  }
  entry.flushing = (async () => {
    // Format-on-save (M14), when enabled and the pool offers a formatter.
    const { formatOnSave } = useApp.getState()
    const lang = entry.model.getLanguageId()
    const wants = lang === 'java' ? formatOnSave.java : formatOnSave.web
    if (wants && saveHook) await saveHook(entry.model).catch(() => {})
    const altId = entry.model.getAlternativeVersionId()
    const content = entry.model.getValue()
    try {
      await client.request('fs.write', {
        projectId: entry.projectId,
        path: entry.relPath,
        content
      })
      entry.diskText = content
      entry.savedAltId = altId
      for (const l of savedListeners) l(entry.model)
    } catch {
      // Write refused/failed: keep pending — the next flush retries.
    }
  })()
  try {
    await entry.flushing
  } finally {
    entry.flushing = null
  }
  const clean = entry.model.getAlternativeVersionId() === entry.savedAltId
  if (clean && entry.state.pending) setState(entry, { pending: false })
  if (entry.queuedReload) {
    entry.queuedReload = false
    // Re-read; if the disk differs from what we just flushed, a second
    // writer truly raced us — surface the bar instead of silently losing.
    try {
      const res = await client.request<FsReadResult>('fs.read', {
        projectId: entry.projectId,
        path: entry.relPath
      })
      if (!res.tooLarge && res.content !== entry.model.getValue()) {
        entry.diskText = res.content
        setState(entry, { conflict: 'external' })
      }
    } catch {
      // deleted meanwhile — that event drives its own state
    }
  }
}

function scheduleFlush(entry: Entry): void {
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  entry.timer = window.setTimeout(() => {
    entry.timer = null
    void flush(entry)
  }, AUTOSAVE_MS)
  if (!entry.state.pending) setState(entry, { pending: true })
}

/** Flush every dirty buffer now (tab/project switch, blur, close, ⌘S). */
export async function flushAll(): Promise<void> {
  await Promise.all(
    [...entries.values()].map((e) => {
      if (e.timer !== null) {
        window.clearTimeout(e.timer)
        e.timer = null
      }
      return flush(e)
    })
  )
}

window.addEventListener('blur', () => void flushAll())
registerFlusher(flushAll)

// ── conflict resolution (the one-line bar's two actions) ─────────────

export function resolveConflict(key: string, action: 'reload' | 'keep'): void {
  const entry = entries.get(key)
  if (!entry) return
  const was = entry.state.conflict
  if (action === 'reload') {
    setState(entry, { conflict: null, pending: false })
    if (was === 'deleted') return // surface offers "close" for this case
    applyExternal(entry, entry.diskText)
    void reloadFromDisk(entry)
  } else {
    // Keep mine: the buffer wins — write it back over the disk version.
    setState(entry, { conflict: null })
    entry.savedAltId = -1 // force the write even if versions look clean
    void flush(entry)
  }
}

// ── open/release ─────────────────────────────────────────────────────

export interface OpenedFile {
  model: monaco.editor.ITextModel | null
  tooLarge: boolean
  key: string
  state: FileState
  onState: (cb: (s: FileState) => void) => () => void
  flushNow: () => Promise<void>
  release: () => void
}

export async function openFile(project: ProjectMeta, relPath: string): Promise<OpenedFile> {
  const key = keyOf(project.id, relPath)
  let entry = entries.get(key)
  if (!entry) {
    const res = await client.request<FsReadResult>('fs.read', {
      projectId: project.id,
      path: relPath
    })
    // A racing open may have created it while we awaited.
    entry = entries.get(key)
    if (!entry) {
      if (res.tooLarge) {
        return {
          model: null,
          tooLarge: true,
          key,
          state: { pending: false, conflict: null },
          onState: () => () => {},
          flushNow: async () => {},
          release: () => {}
        }
      }
      const absPath = `${project.cwd}/${relPath}`
      const uri = monaco.Uri.file(absPath)
      const model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(res.content, languageForPath(relPath), uri)
      const created: Entry = {
        key,
        projectId: project.id,
        relPath,
        absPath,
        model,
        refs: 0,
        diskText: res.content,
        savedAltId: model.getAlternativeVersionId(),
        timer: null,
        flushing: null,
        queuedReload: false,
        applyingExternal: false,
        state: { pending: false, conflict: null },
        stateListeners: new Set(),
        dispose: () => {}
      }
      const sub = model.onDidChangeContent(() => {
        if (created.applyingExternal) return
        scheduleFlush(created)
      })
      created.dispose = () => {
        sub.dispose()
        model.dispose()
      }
      entries.set(key, created)
      byUri.set(uri.toString(), created)
      entry = created
    }
  }
  entry.refs++
  const theEntry = entry
  return {
    model: theEntry.model,
    tooLarge: false,
    key,
    state: theEntry.state,
    onState: (cb) => {
      theEntry.stateListeners.add(cb)
      return () => theEntry.stateListeners.delete(cb)
    },
    flushNow: () => {
      if (theEntry.timer !== null) {
        window.clearTimeout(theEntry.timer)
        theEntry.timer = null
      }
      return flush(theEntry)
    },
    release: () => {
      theEntry.refs--
      if (theEntry.refs > 0) return
      void flush(theEntry).finally(() => {
        if (theEntry.refs > 0) return // reopened while flushing
        entries.delete(key)
        byUri.delete(theEntry.model.uri.toString())
        theEntry.dispose()
        useApp.setState((s) => {
          const fileStates = { ...s.fileStates }
          delete fileStates[key]
          return { fileStates }
        })
      })
    }
  }
}

/** Registry lookup by model URI (LSP layer, cross-file edits). */
export function entryForUri(uri: monaco.Uri): { projectId: string; relPath: string } | null {
  const e = byUri.get(uri.toString())
  return e ? { projectId: e.projectId, relPath: e.relPath } : null
}

// ── problem counts (quiet per-file count in the tab) ─────────────────

monaco.editor.onDidChangeMarkers((uris) => {
  const touched = uris.some((u) => byUri.has(u.toString()))
  if (!touched) return
  const problems: Record<string, number> = {}
  for (const [uriStr, entry] of byUri) {
    const markers = monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(uriStr) })
    const n = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length
    if (n > 0) problems[entry.key] = n
  }
  useApp.setState({ problems })
})
