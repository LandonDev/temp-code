import { useEffect, useState } from 'react'
import { useApp } from './state/store'
import { SessionSidebar } from './components/app/SessionSidebar'
import { Transcript } from './components/app/Transcript'
import { PromptBar } from './components/app/PromptBar'
import { NewSessionDialog } from './components/app/NewSessionDialog'

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const connected = useApp((s) => s.connected)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="flex h-screen">
      <SessionSidebar onNew={() => setShowNew(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b px-6">
          {session ? (
            <>
              <span className="truncate text-sm font-medium">{session.title}</span>
              <span className="text-xs text-muted-foreground">
                {session.model} · {session.reasoning}
              </span>
              <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                {session.cwd}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {connected ? 'temp-code' : 'Connecting…'}
            </span>
          )}
        </header>
        <Transcript />
        <PromptBar />
      </main>
      {showNew && <NewSessionDialog onClose={() => setShowNew(false)} />}
    </div>
  )
}
