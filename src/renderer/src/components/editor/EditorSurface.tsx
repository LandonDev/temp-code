import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { useApp } from '../../state/store'
import { Spinner } from '../ui/spinner'
import { EDITOR_OPTIONS, monaco } from './monaco'
import { ensureForModel } from './lsp'
import { debugFile, paintBreakpoints, toggleBreakpoint } from './debug'
import { installSmartBackspace, showParamInfo } from './param-info'
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
  readOnly = false,
  highlight,
  revealLine,
  onSave
}: {
  project: ProjectMeta
  path: string
  readOnly?: boolean
  /** line ranges to wash (the model's fresh changes, in card embeds) */
  highlight?: { start: number; end: number }[]
  /** cursor + center on this line once the editor has real dimensions */
  revealLine?: number
  /** called after a ⌘S flush lands — card embeds fold back to the diff */
  onSave?: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'tooLarge' | 'error'>('loading')
  const [fileState, setFileState] = useState<FileState>({ pending: false, conflict: null })
  const [key, setKey] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const reveal = useApp((s) => s.reveal)
  // Refs so the mount effect never re-runs (and re-creates the editor)
  // when the caller re-renders with fresh closures.
  const highlightRef = useRef(highlight)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    highlightRef.current = highlight
    onSaveRef.current = onSave
  })

  // Card embeds mount the editor inside a container Monaco hasn't measured
  // yet — a reveal against a zero-height viewport is a no-op. Apply once
  // the layout is real, and again whenever the caller picks a new line.
  useEffect(() => {
    const ed = editorRef.current
    if (phase !== 'ready' || !ed || revealLine === undefined) return
    const pos = { lineNumber: revealLine, column: 1 }
    const apply = (): void => {
      ed.setPosition(pos)
      ed.revealPositionInCenterIfOutsideViewport(pos)
    }
    if (ed.getLayoutInfo().height > 0) {
      apply()
      return
    }
    const d = ed.onDidLayoutChange((info) => {
      if (info.height > 0) {
        apply()
        d.dispose()
      }
    })
    return () => d.dispose()
  }, [phase, revealLine])

  // One-shot reveal (file:line callouts, cross-file goto-definition, ⌘T
  // symbol jumps). Reactive rather than mount-time so a callout click
  // still jumps when this file is already the open surface. The landed
  // line takes a wash that fades — same violet as the callout chip.
  useEffect(() => {
    const ed = editorRef.current
    if (phase !== 'ready' || !ed || !reveal || reveal.key !== `${project.id}:${path}`) return
    useApp.getState().clearReveal()
    ed.setPosition(reveal.position)
    ed.revealPositionInCenterIfOutsideViewport(reveal.position)
    ed.focus()
    const flash = ed.createDecorationsCollection([
      {
        range: new monaco.Range(reveal.position.lineNumber, 1, reveal.position.lineNumber, 1),
        options: { isWholeLine: true, className: 'reveal-flash-line' }
      }
    ])
    setTimeout(() => {
      if (editorRef.current === ed) flash.clear()
    }, 2000)
  }, [phase, reveal, project.id, path])

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
      const debuggable = ['java', 'kotlin'].includes(handle.model.getLanguageId())
      editor = monaco.editor.create(hostRef.current!, {
        ...EDITOR_OPTIONS,
        model: handle.model,
        readOnly,
        // The debugger's breakpoint gutter (docs/PLAN-4.md M20).
        glyphMargin: debuggable
      })
      editorRef.current = editor
      const saved = viewStates.get(stateKey)
      if (saved) editor.restoreViewState(saved)
      editor.focus()
      const hl = highlightRef.current
      if (hl?.length) {
        editor.createDecorationsCollection(
          hl.map((h) => ({
            range: new monaco.Range(h.start, 1, h.end, 1),
            options: { isWholeLine: true, className: 'model-change-line' }
          }))
        )
      }
      // ⌘S flushes early (muscle memory); ⌘P opens quick-open even from
      // inside the buffer.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void handle?.flushNow().then(() => onSaveRef.current?.())
      })
      // ⌘P — IDEA's Parameter Info: every overload stacked, candidate
      // parameter bolded (file search stays on ⇧⇧ / ⌘P outside the buffer).
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
        if (editor) void showParamInfo(editor)
      })
      installSmartBackspace(editor)
      // Alt+Enter — IntelliJ's quickfix reflex (⌘. still works too).
      editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
        editor?.trigger('keyboard', 'editor.action.quickFix', null)
      })
      // ⌃T — IDEA's Refactor This menu (extract variable/method/…).
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyT, () => {
        editor?.trigger('keyboard', 'editor.action.refactor', null)
      })
      // ⌃⌥H callers, ⌃H type hierarchy — IDEA's hierarchy views, served
      // into the quick-open overlay (docs/PLAN-4.md M18).
      const showHierarchy = (variant: 'callers' | 'types'): void => {
        const position = editor?.getPosition()
        const m = editor?.getModel()
        if (!position || !m) return
        void import('./lsp').then(async ({ callHierarchy, typeHierarchy }) => {
          const res = await (variant === 'callers'
            ? callHierarchy(m, position)
            : typeHierarchy(m, position))
          if (res) useApp.getState().openHierarchy(res.title, res.rows)
        })
      }
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyH, () =>
        showHierarchy('callers')
      )
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyH, () => showHierarchy('types'))
      if (debuggable && !readOnly) {
        // Click the gutter to toggle a breakpoint; ⌃D debugs this file.
        paintBreakpoints(editor, project.id, path)
        editor.onMouseDown((e) => {
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            toggleBreakpoint(project, path, e.target.position.lineNumber)
            if (editor) paintBreakpoints(editor, project.id, path)
          }
        })
        editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyD, () => {
          const m = editor?.getModel()
          if (!m) return
          useApp.getState().setRailPanel('debug')
          useApp.setState({ railOpen: true })
          void debugFile(project, path, m.getValue())
        })
      }
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
      editorRef.current = null
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
