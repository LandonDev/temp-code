import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowUp, Check, GitBranch, X } from 'lucide-react'
import type { SessionStatus, SessionMeta } from '@shared/events'
import { childrenOf, useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { activityLine, lastAssistantLine, taskTitle } from '../../lib/activity'
import { SPRING_PANEL } from '../../lib/ease'
import { duration, ProviderMark, StatusDot } from './bits'
import { Spinner } from '../ui/spinner'
import { EDIT_TOOLS, editModel, splitEdit } from './blocks/ToolGroup'
import { UsageRing } from './ContextMeter'
import type { Block } from '../../state/blocks'
import { Transcript } from './Transcript'

/**
 * The subagent fleet, shared by every view that spawns agents: rows lead
 * with the assigned task, rows that need the user (waiting, failed) rise
 * to the top, done rows carry their outcome. A row morphs (shared
 * layoutId) into the agent's detail surface. Orchestration renders the
 * fleet as its hero; implementation shows it under its own work when its
 * thread spawns helpers.
 */

/** Attention order: needs-you first, working next, settled last. */
const RANK: Partial<Record<SessionStatus, number>> = {
  waiting: 0,
  error: 1,
  starting: 2,
  running: 2
}
export const agentRank = (s: SessionStatus): number => RANK[s] ?? 3

/** The parent's children, event streams loaded, in attention order. */
export function useAgents(parentId: string): SessionMeta[] {
  const sessions = useApp((s) => s.sessions)
  const loadSession = useApp((s) => s.loadSession)
  const loaded = useRef(new Set<string>())
  const children = useMemo(() => childrenOf(sessions, parentId), [sessions, parentId])
  // Rows need each child's event stream for task/activity/outcome lines.
  useEffect(() => {
    for (const c of children) {
      if (!loaded.current.has(c.id)) {
        loaded.current.add(c.id)
        void loadSession(c.id)
      }
    }
  }, [children, loadSession])
  return useMemo(
    () =>
      [...children].sort(
        (a, b) => agentRank(a.status) - agentRank(b.status) || a.createdAt - b.createdAt
      ),
    [children]
  )
}

/** "claude-sonnet-5" → "Sonnet 5" (falls back to the raw id). */
function useModelLabel(agent: SessionMeta): string {
  const catalog = useApp((s) => s.catalog)
  return catalog?.[agent.provider]?.models.find((m) => m.id === agent.model)?.label ?? agent.model
}

/** Compacting right now = the latest compaction block never settled. */
const isCompacting = (blocks: Block[] | undefined): boolean =>
  blocks?.findLast((b) => b.kind === 'compaction')?.phase === 'start'

interface AgentStats {
  adds: number
  dels: number
  tasksDone: number
  tasksTotal: number
  /** live context-window fill, 0–100; null until the harness reports one */
  ctxPct: number | null
  compacting: boolean
}

/** The agent's work at a glance: diffstat, task progress, context fill.
 *  Everything derives from data the store already streams; the context
 *  meter refreshes on an interval while the agent is live. */
export function useAgentStats(agent: SessionMeta): AgentStats {
  const blocks = useApp((s) => s.blocks[agent.id])
  const todos = useApp((s) => s.todos[agent.id])
  const ctx = useApp(
    (s) => s.contexts[agent.id] as { percentage?: number; maxTokens?: number } | null | undefined
  )
  const fetchContext = useApp((s) => s.fetchContext)
  const live = agent.status === 'running' || agent.status === 'starting'

  useEffect(() => {
    if (!live) return
    void fetchContext(agent.id)
    const t = setInterval(() => void fetchContext(agent.id), 20_000)
    return () => clearInterval(t)
  }, [live, agent.id, fetchContext])

  const { adds, dels } = useMemo(() => {
    let adds = 0
    let dels = 0
    for (const b of blocks ?? []) {
      if (b.kind !== 'tool' || !EDIT_TOOLS.has(b.name)) continue
      for (const e of splitEdit(b).edits) {
        const m = editModel(e)
        adds += m.adds
        dels += m.dels
      }
    }
    return { adds, dels }
  }, [blocks])

  return {
    adds,
    dels,
    tasksDone: todos?.filter((t) => t.status === 'completed').length ?? 0,
    tasksTotal: todos?.length ?? 0,
    ctxPct: ctx && ctx.maxTokens ? Math.min(100, Math.round(ctx.percentage ?? 0)) : null,
    compacting: isCompacting(blocks)
  }
}

/** The stats, rendered one quiet line: "+120 −45 · 3/7 tasks · ctx 42%". */
export function AgentStatsLine({
  agent,
  className
}: {
  agent: SessionMeta
  className?: string
}): React.JSX.Element | null {
  const s = useAgentStats(agent)
  const parts: React.JSX.Element[] = []
  if (s.adds || s.dels) {
    parts.push(
      <span key="diff" className="tabular-nums">
        <span className="text-success">+{s.adds}</span>{' '}
        <span className="text-destructive">−{s.dels}</span>
      </span>
    )
  }
  if (s.tasksTotal > 0) {
    parts.push(
      <span key="tasks" className="tabular-nums">
        {s.tasksDone}/{s.tasksTotal} tasks · {Math.round((s.tasksDone / s.tasksTotal) * 100)}%
      </span>
    )
  }
  if (s.compacting) {
    parts.push(
      <span key="compact" className="text-violet">
        compacting…
      </span>
    )
  } else if (s.ctxPct !== null) {
    parts.push(
      <span key="ctx" className="flex items-center gap-1 tabular-nums" title="Context usage">
        <UsageRing pct={s.ctxPct} />
        {s.ctxPct}%
      </span>
    )
  }
  if (parts.length === 0) return null
  return (
    <span
      className={cn('flex items-center gap-1.5 text-[11px] text-muted-foreground/70', className)}
    >
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted-foreground/40">·</span>}
          {p}
        </span>
      ))}
    </span>
  )
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
        if (isCompacting(blocks)) return 'compacting the context…'
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

export function AgentRow({
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
        <AgentStatsLine agent={agent} className="mt-px" />
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

export function AgentDetail({
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
              <AgentStatsLine agent={agent} />
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
          minimap={false}
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
