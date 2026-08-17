import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, Users } from 'lucide-react'
import { useApp } from '../../../state/store'
import { useNow } from '../../../lib/useNow'
import { EASE_OUT } from '../../../lib/ease'
import { cn } from '../../../lib/utils'
import { AgentDetail, AgentRow, useAgents } from '../AgentFleet'
import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'
import { WorkingStrip } from '../WorkingStrip'
import { MatrixSpinner } from '../WorkingStrip'

/**
 * Chat thread. Spawning subagents grows a fleet panel on the right — the
 * same rows and drill-in the implementation board uses — while the chat
 * slides left and keeps streaming. The panel follows the fleet: it opens
 * when agents go live, collapses to an edge tab once they all settle, and
 * the tab reopens it any time. The user's toggle overrides either way
 * until the fleet next changes state.
 */
export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const session = useApp((s) => s.sessions[sessionId])
  const sessions = useApp((s) => s.sessions)
  const agents = useAgents(sessionId)
  const working = agents.filter((a) => a.status === 'running' || a.status === 'starting').length
  const waiting = agents.filter((a) => a.status === 'waiting').length
  const anyLive = working > 0 || waiting > 0
  const now = useNow(anyLive)
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const openAgent = openAgentId ? (sessions[openAgentId] ?? null) : null

  // Panel follows the fleet; a manual toggle wins until the fleet next
  // changes state (render-time adjust, same idiom as the board's chat fold).
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [sawLive, setSawLive] = useState(anyLive)
  if (anyLive !== sawLive) {
    setSawLive(anyLive)
    setUserOpen(null)
  }
  const panelOpen = agents.length > 0 && (userOpen ?? anyLive)

  const mainIdle = session?.status !== 'running' && session?.status !== 'starting'

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Transcript sessionId={sessionId} />
        {/* The thread reads as still working while its fleet is — even
            when its own turn has gone dormant awaiting reports. */}
        {mainIdle && anyLive && (
          <div className="mx-auto flex w-full max-w-[688px] shrink-0 items-center gap-2 px-6 pb-1 text-xs text-muted-foreground">
            <MatrixSpinner />
            <span>
              {working > 0
                ? `${working} subagent${working > 1 ? 's' : ''} working`
                : `${waiting} subagent${waiting > 1 ? 's' : ''} waiting on approval`}
            </span>
          </div>
        )}
        <WorkingStrip sessionId={sessionId} />
        <PromptBar />
      </div>

      <AnimatePresence initial={false}>
        {panelOpen && (
          <motion.div
            key="fleet"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 340, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-hairline"
          >
            <div className="flex h-9 w-[340px] shrink-0 items-center justify-between pr-1.5 pl-4">
              <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                Subagents
              </span>
              <button
                onClick={() => setUserOpen(false)}
                title="Hide subagents"
                aria-label="Hide subagents"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 w-[340px] flex-1 overflow-y-auto px-1.5 pb-3">
              <div className="flex flex-col gap-0.5">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    now={now}
                    hidden={openAgentId === agent.id}
                    onOpen={() => setOpenAgentId(agent.id)}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!panelOpen && agents.length > 0 && (
        <button
          onClick={() => setUserOpen(true)}
          title="Show subagents"
          aria-label="Show subagents"
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-hairline pt-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Users className="size-3.5" />
          <span
            className={cn(
              'size-1.5 rounded-full',
              waiting > 0 ? 'bg-warning' : anyLive ? 'animate-pulse bg-success' : 'bg-border'
            )}
          />
        </button>
      )}

      <AnimatePresence>
        {openAgent && session && (
          <AgentDetail
            key={openAgent.id}
            agent={openAgent}
            parent={session}
            onClose={() => setOpenAgentId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
