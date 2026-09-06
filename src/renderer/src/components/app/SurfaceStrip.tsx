import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileCode2, FileDiff, X } from 'lucide-react'
import { surfaceKey, useApp, type SurfaceRef } from '../../state/store'
import { SPRING_LAYOUT } from '../../lib/ease'
import { Tabs, TabsList, TabsTrigger } from '../motion/tabs'

/**
 * The file bar: open file/diff surfaces as tabs on their own line under
 * the thread strip. It exists only while files are open. Each tab wears
 * the file's uncommitted +/− against HEAD (same numstat the Changes rail
 * shows); the right edge carries the language server's busy line while
 * it imports/indexes — gone when idle.
 */
export function SurfaceStrip(): React.JSX.Element | null {
  const projectId = useApp((s) => s.selectedProjectId)
  const surfaces = useApp((s) => (s.selectedProjectId ? s.surfaces[s.selectedProjectId] : null))
  const activeSurface = useApp((s) =>
    s.selectedProjectId ? (s.activeSurface[s.selectedProjectId] ?? null) : null
  )
  const setActiveSurface = useApp((s) => s.setActiveSurface)
  const closeSurface = useApp((s) => s.closeSurface)
  const fileStates = useApp((s) => s.fileStates)
  const problems = useApp((s) => s.problems)
  const changes = useApp((s) => (s.selectedProjectId ? s.changes[s.selectedProjectId] : null))
  const busy = useApp((s) => (s.selectedProjectId ? s.lspBusy[s.selectedProjectId] : null))
  const fetchChanges = useApp((s) => s.fetchChanges)
  const reduce = useReducedMotion()

  const any = (surfaces?.length ?? 0) > 0
  // The +/− counts refresh push-driven on file events; prime them on mount
  // so tabs opened before the first edit aren't blank.
  useEffect(() => {
    if (projectId && any) void fetchChanges(projectId)
  }, [projectId, any, fetchChanges])

  if (!projectId || !any) return null

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-4">
      <Tabs
        value={activeSurface ?? ''}
        onValueChange={(id) => setActiveSurface(projectId, id)}
        variant="soft"
        className="flex min-w-0 items-center self-stretch overflow-x-auto [scrollbar-width:none]"
      >
        <TabsList className="h-full">
          <AnimatePresence initial={false} mode="popLayout">
            {(surfaces ?? []).map((surface) => {
              const key = surfaceKey(surface)
              const stateKey = `${projectId}:${surface.path}`
              const change = changes?.find((c) => c.path === surface.path)
              return (
                <motion.div
                  key={key}
                  layout
                  initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
                  transition={SPRING_LAYOUT}
                >
                  <SurfaceTab
                    surface={surface}
                    pending={fileStates[stateKey]?.pending ?? false}
                    problems={problems[stateKey] ?? 0}
                    adds={change?.adds ?? 0}
                    dels={change?.dels ?? 0}
                    onClose={() => closeSurface(projectId, key)}
                  />
                </motion.div>
              )
            })}
          </AnimatePresence>
        </TabsList>
      </Tabs>
      <div className="flex-1" />
      {busy && (
        <span className="max-w-72 shrink-0 truncate text-[11px] tabular-nums text-muted-foreground/60">
          {busy}
        </span>
      )}
    </div>
  )
}

/** A file/diff surface tab: filename, +/− vs HEAD, pending-save dot,
 *  quiet problem count, hover ×. Middle-click closes. */
function SurfaceTab({
  surface,
  pending,
  problems,
  adds,
  dels,
  onClose
}: {
  surface: SurfaceRef
  pending: boolean
  problems: number
  adds: number
  dels: number
  onClose: () => void
}): React.JSX.Element {
  const name = surface.path.split('/').pop() ?? surface.path
  const Glyph = surface.kind === 'diff' ? FileDiff : FileCode2
  return (
    <div className="group/surface" onAuxClick={(e) => e.button === 1 && onClose()}>
      <TabsTrigger
        value={surfaceKey(surface)}
        className="h-[24px] min-h-0 gap-1.5 px-2.5 py-0 font-normal"
      >
        <Glyph className="size-[13px] opacity-80 text-muted-foreground" />
        <span className="max-w-44 truncate" title={surface.path}>
          {surface.kind === 'diff' ? `Δ ${name}` : name}
          {surface.baseLabel && (
            <span className="text-muted-foreground/70"> · vs {surface.baseLabel}</span>
          )}
        </span>
        {(adds > 0 || dels > 0) && (
          <span className="flex gap-1 text-[10.5px] tabular-nums">
            {adds > 0 && <span className="text-success">+{adds}</span>}
            {dels > 0 && <span className="text-destructive/80">−{dels}</span>}
          </span>
        )}
        {problems > 0 && (
          <span className="text-[10.5px] tabular-nums text-destructive">{problems}</span>
        )}
        {pending && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Close ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="-mr-1 flex size-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/surface:opacity-100"
        >
          <X className="size-3" />
        </span>
      </TabsTrigger>
    </div>
  )
}
