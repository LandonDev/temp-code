import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { useApp } from '../../state/store'
import { Spinner } from '../ui/spinner'
import { EDITOR_OPTIONS, monaco } from './monaco'
import { ensureForModel } from './lsp'
import { openFile, resolveConflict, type FileState, type OpenedFile } from './models'

/**
 * One Monaco editor over one registry model (docs/PLAN-3.md M11). The
 * buffer is the hero: no chrome beyond the one-line conflict bar in the
 * rare case a second writer truly races the autosave window.
 */

/** Scroll/cursor state per surface, restored across tab switches. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

export function EditorSurface({
  project,
  path,
  readOnly = false
}: {
  project: ProjectMeta
  path: string
  readOnly?: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'tooLarge' | 'error'>('loading')
  const [fileState, setFileState] = useState<FileState>({ pending: false, conflict: null })
  const [key, setKey] = useState('')

  useEffect(() => {
    let disposed = false
    let handle: OpenedFile | null = null
    let editor: monaco.editor.IStandaloneCodeEditor | null = null
    const stateKey = `${project.id}:${path}`
    void (async () => {
      try {
        handle = await openFile(project, path)
      } catch {
        if (!disposed) setPhase('error')
        return
      }
      if (disposed) {
        handle.release()
        return
      }
      if (!handle.model) {
        setPhase('tooLarge')
        return
      }
      setKey(handle.key)
      setFileState(handle.state)
      handle.onState(setFileState)
      editor = monaco.editor.create(hostRef.current!, {
        ...EDITOR_OPTIONS,
        model: handle.model,
        readOnly
      })
      const saved = viewStates.get(stateKey)
      if (saved) editor.restoreViewState(saved)
      // One-shot reveal (cross-file goto-definition, ⌘T symbol jumps).
      const { reveal, clearReveal } = useApp.getState()
      if (reveal && reveal.key === stateKey) {
        editor.setPosition(reveal.position)
        editor.revealPositionInCenterIfOutsideViewport(reveal.position)
        clearReveal()
      }
      editor.focus()
      // ⌘S flushes early (muscle memory); ⌘P opens quick-open even from
      // inside the buffer.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void handle?.flushNow()
      })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
        useApp.getState().setQuickOpen('files')
      })
      if (!readOnly) ensureForModel(project, handle.model)
      setPhase('ready')
    })()
    return () => {
      disposed = true
      if (editor) {
        const vs = editor.saveViewState()
        if (vs) viewStates.set(stateKey, vs)
        editor.dispose()
      }
      handle?.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount per (project, path); the parent keys us
  }, [project.id, path, readOnly])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {fileState.conflict && (
        <ConflictBar
          kind={fileState.conflict}
          onReload={() => resolveConflict(key, 'reload')}
          onKeep={() => resolveConflict(key, 'keep')}
          onClose={() => useApp.getState().closeSurface(project.id, `file:${path}`)}
        />
      )}
      {phase === 'loading' && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-3.5 text-muted-foreground" />
        </div>
      )}
      {phase === 'tooLarge' && (
        <Stub text="Too large or binary — this file opens in a real editor, not here." />
      )}
      {phase === 'error' && <Stub text="Could not read this file." />}
      <div
        ref={hostRef}
        className="min-h-0 flex-1"
        style={{ display: phase === 'ready' ? undefined : 'none' }}
      />
    </div>
  )
}

function Stub({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <span className="text-[12px] text-muted-foreground/70">{text}</span>
    </div>
  )
}

/** The honest escape hatch: one line, two words each, no modal. */
function ConflictBar({
  kind,
  onReload,
  onKeep,
  onClose
}: {
  kind: 'external' | 'deleted'
  onReload: () => void
  onKeep: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border/60 bg-warning/10 px-3 text-[12px]">
      <span className="text-muted-foreground">
        {kind === 'external' ? 'Changed on disk while you were typing' : 'Deleted on disk'}
      </span>
      <span className="flex-1" />
      {kind === 'external' ? (
        <button onClick={onReload} className="font-medium hover:underline">
          reload
        </button>
      ) : (
        <button onClick={onClose} className="font-medium hover:underline">
          close
        </button>
      )}
      <span className="text-muted-foreground/50">·</span>
      <button onClick={onKeep} className="font-medium hover:underline">
        keep mine
      </button>
    </div>
  )
}
