import { useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { Spinner } from '../ui/spinner'
import { monacoReady } from './monaco'
import { registerProviders } from './lsp'
import { EditorSurface } from './EditorSurface'

/**
 * The full editor embedded in a transcript card: the same model registry,
 * autosave, conflict bar and LSP as the file surface — height-capped, and
 * revealed at the change the card is about. Lazy like EditorHost: Monaco
 * loads only when a card actually enters edit mode.
 */
export default function InlineEditor({
  project,
  path,
  line,
  highlight,
  onSave
}: {
  project: ProjectMeta
  path: string
  line?: number
  /** the model's changed line ranges, washed in the buffer */
  highlight?: { start: number; end: number }[]
  /** ⌘S saved — the card folds back to its diff */
  onSave?: () => void
}): React.JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void monacoReady().then(() => {
      registerProviders()
      setReady(true)
    })
  }, [])
  if (!ready) {
    return (
      <div className="flex h-80 items-center justify-center">
        <Spinner className="size-3.5 text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="flex h-80 flex-col">
      <EditorSurface
        project={project}
        path={path}
        highlight={highlight}
        revealLine={line}
        onSave={onSave}
      />
    </div>
  )
}
