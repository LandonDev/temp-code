import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { Spinner } from '../ui/spinner'
import { EDITOR_OPTIONS, languageForPath, monaco } from './monaco'
import { ensureForModel } from './lsp'
import { openFile, type OpenedFile } from './models'

/**
 * A diff surface (docs/PLAN-3.md M14): `git show <base>:<path>` on the
 * left (HEAD by default; the Branch rail passes the merge base), the live
 * disk model on the right — editable, autosaving through the same
 * registry as any file surface. "Edit the agent's change as you review
 * it", and the exact surface the in-thread flow will reuse.
 */
export function DiffSurface({
  project,
  path,
  base
}: {
  project: ProjectMeta
  path: string
  base?: string
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let disposed = false
    let handle: OpenedFile | null = null
    let editor: monaco.editor.IStandaloneDiffEditor | null = null
    let original: monaco.editor.ITextModel | null = null
    void (async () => {
      try {
        const [head, opened] = await Promise.all([
          client.request<string | null>('project.show', { projectId: project.id, path, ref: base }),
          openFile(project, path)
        ])
        handle = opened
        if (disposed || !opened.model) {
          if (!disposed) setPhase('error')
          return
        }
        // Untracked/added file: HEAD has nothing — diff against empty.
        original = monaco.editor.createModel(head ?? '', languageForPath(path))
        editor = monaco.editor.createDiffEditor(hostRef.current!, {
          ...EDITOR_OPTIONS,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: true,
          originalEditable: false,
          renderOverviewRuler: false,
          diffAlgorithm: 'advanced'
        })
        editor.setModel({ original, modified: opened.model })
        ensureForModel(project, opened.model)
        setPhase('ready')
      } catch {
        if (!disposed) setPhase('error')
      }
    })()
    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      handle?.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount per (project, path, base); the parent keys us
  }, [project.id, path, base])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {phase === 'loading' && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-3.5 text-muted-foreground" />
        </div>
      )}
      {phase === 'error' && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[12px] text-muted-foreground/70">Could not open this diff.</span>
        </div>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1"
        style={{ display: phase === 'ready' ? undefined : 'none' }}
      />
    </div>
  )
}
