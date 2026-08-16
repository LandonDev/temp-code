import { useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { useApp } from '../../state/store'
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
  line
}: {
  project: ProjectMeta
  path: string
  line?: number
}): React.JSX.Element {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void monacoReady().then(() => {
      registerProviders()
      if (line !== undefined) {
        useApp.setState({
          reveal: { key: `${project.id}:${path}`, position: { lineNumber: line, column: 1 } }
        })
      }
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount
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
      <EditorSurface project={project} path={path} />
    </div>
  )
}
