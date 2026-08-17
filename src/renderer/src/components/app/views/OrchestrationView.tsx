import { useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { SessionStatus, SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { useNow } from '../../../lib/useNow'
import { AgentDetail, AgentRow, useAgents } from '../AgentFleet'
import { Transcript } from '../Transcript'
import { SidePanel } from '../SidePanel'
import { PromptBar } from '../PromptBar'

/**
 * Orchestration thread: a fleet of subagents as full-width rows — a live
 * operations table (rows and the detail morph live in AgentFleet). Until
 * the first agent spawns, the orchestrator's own stream is the view.
 */
export function OrchestrationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const [openId, setOpenId] = useState<string | null>(null)
  const ordered = useAgents(session.id)

  const blocks = useApp((s) => s.blocks[session.id])
  const running = session.status === 'running' || session.status === 'starting'
  const anyLive = ordered.some((c) => c.status === 'running' || c.status === 'starting')
  const now = useNow(anyLive)
  const open = openId ? (sessions[openId] ?? null) : null

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {ordered.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto select-text">
            <div className="mx-auto w-full max-w-3xl px-6 py-5">
              <FleetHeader session={session} agents={ordered} />
              <div className="-mx-3 flex flex-col gap-0.5">
                {ordered.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    now={now}
                    hidden={openId === agent.id}
                    onOpen={() => setOpenId(agent.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : blocks?.length || running ? (
          // No agents yet — the orchestrator's triage stream IS the view.
          <Transcript sessionId={session.id} className="min-h-0 flex-1 select-text" />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-xs text-center text-[13px] leading-relaxed text-muted-foreground/70">
              Describe the goal below — the orchestrator splits it across subagents and picks a
              model for each.
            </p>
          </div>
        )}

        <PromptBar compact />
      </div>

      <SidePanel sessionId={session.id} label="Orchestrator log" />

      <AnimatePresence>
        {open && (
          <AgentDetail
            key={open.id}
            agent={open}
            parent={session}
            onClose={() => setOpenId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** Goal + fleet pulse: per-agent progress segments, counts, total spend. */
function FleetHeader({
  session,
  agents
}: {
  session: SessionMeta
  agents: SessionMeta[]
}): React.JSX.Element {
  // The LATEST request is the active goal — a follow-up replaces the
  // original headline instead of hiding behind it.
  const goal = useApp((s) => s.blocks[session.id])?.findLast((b) => b.kind === 'user')
  const n = (s: SessionStatus[]): number => agents.filter((a) => s.includes(a.status)).length
  const counts: [number, string, string?][] = [
    [n(['running', 'starting']), 'working'],
    [n(['waiting']), 'needs approval', 'text-warning'],
    [n(['error']), 'failed', 'text-destructive'],
    [n(['idle']), 'done']
  ]

  const SEG: Partial<Record<SessionStatus, string>> = {
    idle: 'bg-success',
    running: 'bg-success/35 animate-pulse',
    starting: 'bg-success/35 animate-pulse',
    waiting: 'bg-warning',
    error: 'bg-destructive'
  }

  return (
    <div className="mb-4">
      {goal?.kind === 'user' && (
        <p className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
          {goal.text.split('\n')[0]}
        </p>
      )}
      <div
        className="mt-3 flex h-[3px] gap-[3px]"
        role="img"
        aria-label={`${n(['idle'])} of ${agents.length} agents done`}
      >
        {agents.map((a) => (
          <span
            key={a.id}
            className={cn(
              'min-w-0 flex-1 rounded-full transition-colors duration-300',
              SEG[a.status] ?? 'bg-border'
            )}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
        {counts
          .filter(([c]) => c > 0)
          .map(([c, label, tint], i) => (
            <span key={label} className={tint}>
              {i > 0 && <span className="text-muted-foreground/50"> · </span>}
              {c} {label}
            </span>
          ))}
      </p>
    </div>
  )
}
