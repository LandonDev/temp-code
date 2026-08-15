import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, Check, GitBranch, X } from 'lucide-react'
import type { SessionStatus, SessionMeta } from '@shared/events'
import { childrenOf, useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { activityLine, lastAssistantLine, taskTitle } from '../../../lib/activity'
import { useNow } from '../../../lib/useNow'
import { SPRING_PANEL } from '../../../lib/ease'
import { duration, ProviderMark, StatusDot } from '../bits'
import { Spinner } from '../../ui/spinner'
import { Transcript } from '../Transcript'
import { SidePanel } from '../SidePanel'
import { PromptBar } from '../PromptBar'

/**
 * Orchestration thread: a fleet of subagents as full-width rows — a live
 * operations table. Rows lead with the assigned task; rows that need the
 * user (waiting, failed) rise to the top; done rows carry their outcome.
 * A row morphs (shared layoutId) into the agent's detail surface. Until
 * the first agent spawns, the orchestrator's own stream is the view.
 */

/** Attention order: needs-you first, working next, settled last. */
const RANK: Partial<Record<SessionStatus, number>> = {
  waiting: 0,
  error: 1,
  starting: 2,
  running: 2
}
const rank = (s: SessionStatus): number => RANK[s] ?? 3

export function OrchestrationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const loadSession = useApp((s) => s.loadSession)
  const [openId, setOpenId] = useState<string | null>(null)
  const loaded = useRef(new Set<string>())

  const children = useMemo(() => childrenOf(sessions, session.id), [sessions, session.id])

  // Rows need each child's event stream for task/activity/outcome lines.
  useEffect(() => {
    for (const c of children) {
      if (!loaded.current.has(c.id)) {
        loaded.current.add(c.id)
        void loadSession(c.id)
      }
    }
  }, [children, loadSession])

  const ordered = useMemo(
    () =>
      [...children].sort((a, b) => rank(a.status) - rank(b.status) || a.createdAt - b.createdAt),
    [children]
  )

  const blocks = useApp((s) => s.blocks[session.id])
  const running = session.status === 'running' || session.status === 'starting'
  const anyLive = ordered.some((c) => c.status === 'running' || c.status === 'starting')
  const now = useNow(anyLive)
  const open = openId ? (sessions[openId] ?? null) : null

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {children.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto select-text">
            <div className="mx-auto w-full max-w-3xl px-6 py-5">
              <FleetHeader session={session} agents={children} />
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
  const goal = useApp((s) => s.blocks[session.id])?.find((b) => b.kind === 'user')
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

/** "claude-sonnet-5" → "Sonnet 5" (falls back to the raw id). */
function useModelLabel(agent: SessionMeta): string {
  const catalog = useApp((s) => s.catalog)
  return catalog?.[agent.provider]?.models.find((m) => m.id === agent.model)?.label ?? agent.model
}

/** The status-dependent second line: what this agent needs or last did. */
function useAgentLine(agent: SessionMeta): { text: string | null; tone: string } {
  const line = useApp((s) => {
    const blocks = s.blocks[agent.id]
    switch (agent.status) {
      case 'waiting': {
        const question = blocks?.findLast((b) => b.kind === 'question' && !b.resolved)
        if (question?.kind === 'question') {
          return `has a question — ${question.questions[0]?.question ?? ''}`
        }
        const approval = blocks?.findLast((b) => b.kind === 'approval' && !b.resolved)
        return approval?.kind === 'approval'
          ? `waiting for approval — ${approval.title ?? approval.toolName}`
          : 'waiting for approval'
      }
      case 'error': {
        const err = blocks?.findLast((b) => b.kind === 'error')
        return err?.kind === 'error' ? err.text : 'failed'
      }
      case 'running':
      case 'starting':
        return activityLine(blocks)
      default:
        return lastAssistantLine(blocks)
    }
  })
  const tone =
    agent.status === 'waiting'
      ? 'text-warning'
      : agent.status === 'error'
        ? 'text-destructive'
        : 'text-muted-foreground'
  return { text: line, tone }
}

function StatusGlyph({ status }: { status: SessionStatus }): React.JSX.Element {
  if (status === 'running' || status === 'starting') return <Spinner className="size-3.5" />
  if (status === 'waiting') return <span className="size-2 animate-pulse rounded-full bg-warning" />
  if (status === 'error') return <X className="size-3.5 text-destructive" />
  return <Check className="size-3.5 text-success" />
}

function AgentRow({
  agent,
  now,
  hidden,
  onOpen
}: {
  agent: SessionMeta
  now: number
  hidden: boolean
  onOpen: () => void
}): React.JSX.Element {
  const title = useApp((s) => taskTitle(s.blocks[agent.id])) ?? agent.title
  const cost = useApp((s) => s.costs[agent.id])
  const model = useModelLabel(agent)
  const { text, tone } = useAgentLine(agent)
  const live = agent.status === 'running' || agent.status === 'starting'
  const elapsed = live ? now - agent.createdAt : agent.updatedAt - agent.createdAt

  return (
    <motion.button
      layout
      layoutId={`agent-${agent.id}`}
      transition={SPRING_PANEL}
      onClick={onOpen}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: hidden ? 0 : 1, y: 0 }}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/40 active:scale-[0.997]"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusGlyph status={agent.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px] font-medium',
            agent.status === 'idle' && 'text-muted-foreground'
          )}
        >
          {title}
        </span>
        <span className={cn('block truncate text-[11px] leading-4', tone, !text && 'italic')}>
          {text ?? 'starting up'}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-px">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ProviderMark provider={agent.provider} size={11} />
          {model}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/60">
          {elapsed > 2000 && duration(elapsed)}
          {cost !== undefined && ` · $${cost.toFixed(2)}`}
        </span>
      </span>
    </motion.button>
  )
}

function AgentDetail({
  agent,
  parent,
  onClose
}: {
  agent: SessionMeta
  parent: SessionMeta
  onClose: () => void
}): React.JSX.Element {
  const send = useApp((s) => s.send)
  const cost = useApp((s) => s.costs[agent.id])
  const title = useApp((s) => taskTitle(s.blocks[agent.id])) ?? agent.title
  const model = useModelLabel(agent)
  const [text, setText] = useState('')
  const reduce = useReducedMotion()
  // Isolated worktree branch, when the agent got one.
  const branch = agent.cwd !== parent.cwd ? `tc/${agent.cwd.split('/').at(-1)}` : null

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(agent.id, t)
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
      />
      <motion.div
        layoutId={`agent-${agent.id}`}
        transition={SPRING_PANEL}
        className="relative flex h-full max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-[0_8px_40px_rgb(0_0_0/0.18)]"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-4 py-2.5">
          <StatusDot status={agent.status} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{title}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ProviderMark provider={agent.provider} size={11} />
              {agent.agentType} · {model} · {agent.reasoning}
              {branch && (
                <span className="flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70">
                  <GitBranch className="size-2.5" />
                  {branch}
                </span>
              )}
            </span>
          </span>
          {cost !== undefined && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              ${cost.toFixed(2)}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close agent detail"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <Transcript
          sessionId={agent.id}
          className="min-h-0 flex-1 overflow-y-auto bg-background select-text"
        />

        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Send to this agent…"
            className="h-7 flex-1 rounded-md bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            className={cn(
              'flex size-6 items-center justify-center rounded-full transition active:scale-95',
              text.trim()
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground'
            )}
          >
            <ArrowUp className="size-3.5" />
          </button>
        </div>
      </motion.div>
    </div>
  )
}
