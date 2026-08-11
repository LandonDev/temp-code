import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, ChevronRight, X } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { childrenOf, useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { SPRING_PANEL } from '../../../lib/ease'
import { ProviderMark, StatusDot, timeAgo } from '../bits'
import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'

/**
 * Orchestration thread: the subagent board. Each agent is a capsule; click
 * one and it morphs (shared layoutId) into the detail surface with its live
 * feed. Exit reverses the same path — spatial consistency, interruptible.
 */
export function OrchestrationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const loadSession = useApp((s) => s.loadSession)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showFeed, setShowFeed] = useState(false)
  const loaded = useRef(new Set<string>())

  const children = useMemo(() => childrenOf(sessions, session.id), [sessions, session.id])

  // Live activity lines need each child's event stream.
  useEffect(() => {
    for (const c of children) {
      if (!loaded.current.has(c.id)) {
        loaded.current.add(c.id)
        void loadSession(c.id)
      }
    }
  }, [children, loadSession])

  const goal = useApp((s) => s.blocks[session.id])?.find((b) => b.kind === 'user')
  const open = openId ? (sessions[openId] ?? null) : null

  return (
    <>
      <div className="flex-1 overflow-y-auto select-text">
        <div className="mx-auto w-full max-w-3xl px-6 py-5">
          {goal?.kind === 'user' && (
            <div className="mb-5 flex items-start justify-between gap-4">
              <p className="text-[15px] font-medium leading-snug tracking-[-0.01em]">
                {goal.text.split('\n')[0]}
              </p>
              {session.status === 'running' && (
                <span className="mt-1 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <StatusDot status="running" /> orchestrating
                </span>
              )}
            </div>
          )}

          {children.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground/70">
              No subagents yet — they appear here as the orchestrator spawns them.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
              {children.map((agent) => (
                <AgentCapsule
                  key={agent.id}
                  agent={agent}
                  hidden={openId === agent.id}
                  onOpen={() => setOpenId(agent.id)}
                />
              ))}
            </div>
          )}

          {/* orchestrator's own narration, out of the way */}
          <div className="mt-6">
            <button
              onClick={() => setShowFeed(!showFeed)}
              className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', showFeed && 'rotate-90')}
              />
              Orchestrator feed
            </button>
          </div>
        </div>
        {showFeed && (
          <Transcript
            sessionId={session.id}
            className="h-80 overflow-y-auto border-t border-border/60 select-text"
          />
        )}
      </div>
      <PromptBar compact />

      <AnimatePresence>
        {open && <AgentDetail key={open.id} agent={open} onClose={() => setOpenId(null)} />}
      </AnimatePresence>
    </>
  )
}

/** One line about what the agent is doing right now. */
function activityLine(blocks: Block[] | undefined): string | null {
  if (!blocks?.length) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'tool') {
      const input = (b.input ?? {}) as Record<string, unknown>
      const detail = [
        input.command,
        input.file_path,
        input.pattern,
        input.description,
        input.query
      ].find((v) => typeof v === 'string') as string | undefined
      return detail ? `${b.name} · ${detail}` : b.name
    }
    if (b.kind === 'assistant' && b.text.trim()) return b.text.trim().split('\n')[0]
    if (b.kind === 'error') return b.text
  }
  return null
}

const STATUS_LABEL: Record<string, string> = {
  running: 'working',
  waiting: 'needs approval',
  starting: 'starting',
  idle: 'done',
  error: 'failed',
  done: 'done'
}

/** "claude-sonnet-5" → "Sonnet 5" (falls back to the raw id). */
function useModelLabel(agent: SessionMeta): string {
  const catalog = useApp((s) => s.catalog)
  return catalog?.[agent.provider]?.models.find((m) => m.id === agent.model)?.label ?? agent.model
}

function AgentCapsule({
  agent,
  hidden,
  onOpen
}: {
  agent: SessionMeta
  hidden: boolean
  onOpen: () => void
}): React.JSX.Element {
  const activity = useApp((s) => activityLine(s.blocks[agent.id]))
  const cost = useApp((s) => s.costs[agent.id])
  const model = useModelLabel(agent)

  return (
    <motion.button
      layoutId={`agent-${agent.id}`}
      transition={SPRING_PANEL}
      onClick={onOpen}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: hidden ? 0 : 1, scale: 1 }}
      className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-accent/40 active:scale-[0.99]"
    >
      <div className="flex w-full items-center gap-2">
        <ProviderMark provider={agent.provider} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {agent.agentType} · {model}
        </span>
        <StatusDot status={agent.status} />
      </div>
      <p
        className={cn(
          'min-h-8 w-full text-[11px] leading-4 text-muted-foreground',
          !activity && 'italic text-muted-foreground/50'
        )}
      >
        {activity
          ? activity.length > 90
            ? `${activity.slice(0, 90)}…`
            : activity
          : 'no output yet'}
      </p>
      <div className="flex w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground/60">
        <span>{STATUS_LABEL[agent.status] ?? agent.status}</span>
        <span className="ml-auto">{timeAgo(agent.createdAt)}</span>
        {cost !== undefined && <span>${cost.toFixed(2)}</span>}
      </div>
    </motion.button>
  )
}

function AgentDetail({
  agent,
  onClose
}: {
  agent: SessionMeta
  onClose: () => void
}): React.JSX.Element {
  const send = useApp((s) => s.send)
  const cost = useApp((s) => s.costs[agent.id])
  const model = useModelLabel(agent)
  const [text, setText] = useState('')
  const reduce = useReducedMotion()

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
        className="absolute inset-0 bg-background/50"
      />
      <motion.div
        layoutId={`agent-${agent.id}`}
        transition={SPRING_PANEL}
        className="relative flex h-full max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-[0_8px_40px_rgb(0_0_0/0.18)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <ProviderMark provider={agent.provider} />
          <span className="text-[13px] font-medium">
            {agent.agentType} · {model}
          </span>
          <StatusDot status={agent.status} />
          <span className="text-[11px] text-muted-foreground">
            {STATUS_LABEL[agent.status] ?? agent.status}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {cost !== undefined && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                ${cost.toFixed(2)}
              </span>
            )}
            <button
              onClick={onClose}
              aria-label="Close agent detail"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-90"
            >
              <X className="size-3.5" />
            </button>
          </div>
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
              'flex size-6 items-center justify-center rounded-full transition-colors active:scale-90',
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
