import { useEffect, useState } from 'react'
import { surfaceKey, useApp } from '../../state/store'
import { Spinner } from '../ui/spinner'
import { monacoReady } from './monaco'
import { registerProviders } from './lsp'
import { EditorSurface } from './EditorSurface'
import { DiffSurface } from './DiffSurface'

/**
 * The lazy boundary (docs/PLAN-3.md M11): App pulls this chunk in the
 * first time a file/diff surface goes active — Monaco, shiki grammars, and
 * the LSP client all live behind it, never in the startup path.
 */
export default function EditorHost(): React.JSX.Element | null {
  const projectId = useApp((s) => s.selectedProjectId)
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const active = useApp((s) => (s.selectedProjectId ? s.activeSurface[s.selectedProjectId] : null))
  const surface = useApp((s) =>
    s.selectedProjectId && active
      ? (s.surfaces[s.selectedProjectId] ?? []).find((x) => surfaceKey(x) === active)
      : undefined
  )
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void monacoReady().then(() => {
      registerProviders()
      setReady(true)
    })
  }, [])

  if (!projectId || !project || !active) return null
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-3.5 text-muted-foreground" />
      </div>
    )
  }
  const sep = active.indexOf(':')
  const kind = surface?.kind ?? active.slice(0, sep)
  const path = surface?.path ?? active.slice(sep + 1)
  return kind === 'diff' ? (
    <DiffSurface
      key={`${projectId}:${active}`}
      project={project}
      path={path}
      base={surface?.base}
    />
  ) : (
    <EditorSurface key={`${projectId}:${active}`} project={project} path={path} />
  )
}
