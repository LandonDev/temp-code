import { lazy, Suspense, useEffect } from 'react'
import { motion } from 'motion/react'
import { FolderPlus } from 'lucide-react'
import { EASE_OUT } from './lib/ease'
import { flushAllBuffers } from './lib/file-events'
import { useApp } from './state/store'
import { Sidebar } from './components/app/Sidebar'
import { Titlebar } from './components/app/Titlebar'
import { ThreadStrip } from './components/app/ThreadStrip'
import { SurfaceStrip } from './components/app/SurfaceStrip'
import { RightRail } from './components/app/RightRail'
import { QuickOpen } from './components/app/QuickOpen'
import { AppshotFlyIn } from './components/app/AppshotFlyIn'
import { Lightbox } from './components/app/Lightbox'
import { ChatView } from './components/app/views/ChatView'
import { PlanView } from './components/app/views/PlanView'
import { ImplementationView } from './components/app/views/ImplementationView'
import { OrchestrationView } from './components/app/views/OrchestrationView'
import { SettingsView } from './components/app/views/SettingsView'
import { Spinner } from './components/ui/spinner'

// Monaco and everything that touches it stays behind this boundary — the
// chunk loads the first time a file/diff surface goes active.
const EditorHost = lazy(() => import('./components/editor/EditorHost'))

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const connected = useApp((s) => s.connected)
  const workspaces = useApp((s) => s.workspaces)
  const projectId = useApp((s) => s.selectedProjectId)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const activeSurface = useApp((s) =>
    s.selectedProjectId ? (s.activeSurface[s.selectedProjectId] ?? null) : null
  )
  const settingsOpen = useApp((s) => s.settingsOpen)
  const addWorkspace = useApp((s) => s.addWorkspace)

  useEffect(() => {
    void init()
  }, [init])

  // Global keys. ⌘P files, ⌘T/⌘O symbols, ⌘S flush; double-tap Shift is
  // IntelliJ's Search Everywhere → file search. Monaco surfaces re-bind
  // their own ⌘S/⌘P so focus inside the buffer behaves the same; bare
  // Shift bubbles out of Monaco untouched, so the double-tap works there
  // too. Any other keystroke between the taps (⇧A while typing) resets.
  useEffect(() => {
    let lastShiftAt = 0
    const onKey = (e: KeyboardEvent): void => {
      const { selectedProjectId, setQuickOpen, quickOpen } = useApp.getState()
      if (e.key === 'Shift' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = Date.now()
        if (now - lastShiftAt < 400 && selectedProjectId && !quickOpen) {
          setQuickOpen('files')
          lastShiftAt = 0
        } else {
          lastShiftAt = now
        }
        return
      }
      lastShiftAt = 0
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'p' && selectedProjectId) {
        e.preventDefault()
        setQuickOpen('files')
      } else if ((e.key === 't' || e.key === 'o') && selectedProjectId) {
        // ⌘O: IntelliJ go-to-class muscle memory → workspace symbols.
        e.preventDefault()
        setQuickOpen('symbols')
      } else if (e.key === 's') {
        e.preventDefault()
        void flushAllBuffers()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col border-l border-border/60 bg-background">
        <Titlebar />
        {settingsOpen ? (
          <motion.div
            key="settings"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, ease: EASE_OUT }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <SettingsView />
          </motion.div>
        ) : (
          <>
            <ThreadStrip />
            <SurfaceStrip />
            {activeSurface ? (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center">
                    <Spinner className="size-3.5 text-muted-foreground" />
                  </div>
                }
              >
                <EditorHost />
              </Suspense>
            ) : session ? (
              // Keyed remount per thread; the brief fade bridges the swap without
              // ever delaying it (no exit animation).
              <motion.div
                key={session.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12, ease: EASE_OUT }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <ThreadView sessionId={session.id} />
              </motion.div>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                {!connected ? (
                  <span className="text-[13px] text-muted-foreground">Connecting…</span>
                ) : workspaces.length === 0 ? (
                  <button
                    onClick={() =>
                      void window.api.pickDirectory().then((p) => {
                        if (p) void addWorkspace(p)
                      })
                    }
                    className="flex flex-col items-center gap-2 rounded-xl px-8 py-6 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <FolderPlus className="size-6" strokeWidth={1.5} />
                    <span className="text-[13px]">Add a workspace to get started</span>
                  </button>
                ) : (
                  <span className="text-[13px] text-muted-foreground/70">
                    {projectId ? 'Start a thread above' : 'Pick or create a project'}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <RightRail />
      <QuickOpen />
      <AppshotFlyIn />
      <Lightbox />
    </div>
  )
}

function ThreadView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const session = useApp((s) => s.sessions[sessionId])
  switch (session?.threadType) {
    case 'planning':
      return <PlanView session={session} />
    case 'implementation':
      return <ImplementationView session={session} />
    case 'orchestration':
      return <OrchestrationView session={session} />
    default:
      return <ChatView sessionId={sessionId} />
  }
}
