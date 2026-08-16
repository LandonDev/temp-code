import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileCode2, Braces } from 'lucide-react'
import { useApp } from '../../state/store'
import { rankFiles } from '../../lib/rank'
import { cn } from '../../lib/utils'
import { EASE_OUT } from '../../lib/ease'

interface SymbolRow {
  name: string
  containerName: string
  uri: string
  range: { startLineNumber: number; startColumn: number }
}

/**
 * ⌘P quick-open and ⌘T workspace symbols (docs/PLAN-3.md M11/M14) — one
 * overlay, two sources. Files rank through the same function as the
 * PromptBar's @-mention menu; symbols fan out to the project's running
 * language servers (never starting one just to search).
 */
export function QuickOpen(): React.JSX.Element | null {
  const mode = useApp((s) => s.quickOpen)
  const setQuickOpenRaw = useApp((s) => s.setQuickOpen)
  const projectId = useApp((s) => s.selectedProjectId)
  const hierarchy = useApp((s) => s.hierarchy)
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const files = useApp((s) => (s.selectedProjectId ? s.files[s.selectedProjectId] : undefined))
  const fetchFiles = useApp((s) => s.fetchFiles)
  const openFileSurface = useApp((s) => s.openFileSurface)
  const [query, setQuery] = useState('')
  const [symbols, setSymbols] = useState<SymbolRow[]>([])
  const [at, setAt] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const reduce = useReducedMotion()
  const setQuickOpen = (m: 'files' | 'symbols' | 'hierarchy' | null): void => {
    setQuickOpenRaw(m)
    if (m === null) {
      setQuery('')
      setSymbols([])
      setAt(0)
    }
  }

  useEffect(() => {
    if (mode === 'files' && projectId) void fetchFiles(projectId)
  }, [mode, projectId, fetchFiles])

  // Symbols query the pool as you type (250 ms settle).
  useEffect(() => {
    if (mode !== 'symbols' || !project || !query.trim()) return
    let alive = true
    const t = setTimeout(() => {
      void import('../editor/lsp').then(async ({ workspaceSymbols }) => {
        const rows = await workspaceSymbols(project, query.trim())
        if (alive) {
          setSymbols(rows)
          setAt(0)
        }
      })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [mode, project, query])

  if (!mode || !projectId || !project) return null

  const fileRows = mode === 'files' ? rankFiles(files ?? [], query.trim(), 12) : []
  const q = query.trim().toLowerCase()
  // Hierarchy rows arrive precomputed (⌃H / ⌃⌥H); typing filters them.
  const shownSymbols =
    mode === 'hierarchy'
      ? (hierarchy?.rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q))
      : query.trim()
        ? symbols
        : []
  const count = mode === 'files' ? fileRows.length : shownSymbols.length

  const openAt = (index: number): void => {
    if (mode === 'files') {
      const path = fileRows[index]
      if (!path) return
      openFileSurface(projectId, path, null)
    } else {
      const sym = shownSymbols[index]
      if (!sym) return
      const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
      const symPath = decodeURIComponent(sym.uri.replace(/^file:\/\//, ''))
      if (!symPath.startsWith(root)) return
      openFileSurface(projectId, symPath.slice(root.length), {
        lineNumber: sym.range.startLineNumber,
        column: sym.range.startColumn
      })
    }
    setQuickOpen(null)
  }

  return (
    <AnimatePresence>
      <motion.div
        key="quick-open"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.1, ease: EASE_OUT }}
        className="fixed inset-0 z-50 bg-black/20"
        onMouseDown={() => setQuickOpen(null)}
      >
        <motion.div
          initial={reduce ? false : { opacity: 0, y: -6, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.14, ease: EASE_OUT }}
          onMouseDown={(e) => e.stopPropagation()}
          className="mx-auto mt-[18vh] w-[520px] overflow-hidden rounded-xl border border-border-strong bg-popover shadow-2xl"
        >
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuickOpen(null)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setAt((v) => Math.min(v + 1, count - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setAt((v) => Math.max(v - 1, 0))
              }
              if (e.key === 'Enter') openAt(at)
            }}
            placeholder={
              mode === 'files'
                ? 'Go to file…'
                : mode === 'hierarchy'
                  ? (hierarchy?.title ?? 'Hierarchy')
                  : 'Go to symbol in project…'
            }
            className="w-full border-b border-border/60 bg-transparent px-4 py-3 text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
          <div className="max-h-[320px] overflow-y-auto p-1">
            {mode === 'files' &&
              fileRows.map((path, i) => (
                <button
                  key={path}
                  onClick={() => openAt(i)}
                  onMouseMove={() => setAt(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
                    i === at && 'bg-accent'
                  )}
                >
                  <FileCode2 className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="truncate text-[13px]">{path.split('/').pop()}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
                    {path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}
                  </span>
                </button>
              ))}
            {(mode === 'symbols' || mode === 'hierarchy') &&
              shownSymbols.map((sym, i) => (
                <button
                  key={`${sym.uri}:${i}`}
                  onClick={() => openAt(i)}
                  onMouseMove={() => setAt(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
                    i === at && 'bg-accent'
                  )}
                >
                  <Braces className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="truncate text-[13px]">{sym.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
                    {sym.containerName}
                  </span>
                </button>
              ))}
            {count === 0 && (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
                {mode === 'symbols' && !query.trim()
                  ? 'Type to search symbols'
                  : mode === 'hierarchy'
                    ? 'Nothing found here'
                    : 'No matches'}
              </p>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
