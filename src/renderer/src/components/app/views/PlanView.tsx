import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, GitFork, ListChecks, Play } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { SPRING_LAYOUT } from '../../../lib/ease'
import { MarkdownText } from '../blocks/MarkdownText'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'

/**
 * Planning thread: the plan document IS the view. The agent writes a real
 * file; we poll it while the thread works. The conversation is a collapsed
 * side-channel below the document.
 */
export function PlanView({ session }: { session: SessionMeta }): React.JSX.Element {
  const readFile = useApp((s) => s.readFile)
  const [doc, setDoc] = useState<string | null>(null)
  const [showChat, setShowChat] = useState(true)
  const reduce = useReducedMotion()
  const running = session.status === 'running' || session.status === 'starting'

  useEffect(() => {
    if (!session.planPath) return
    let alive = true
    const poll = async (): Promise<void> => {
      const content = await readFile(session.planPath!)
      if (alive && content !== null) setDoc(content)
    }
    void poll()
    const t = setInterval(() => void poll(), running ? 1500 : 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [session.planPath, running, readFile])

  const hasDoc = doc !== null && doc.trim().length > 0
  // Collapse the conversation once a document exists — it becomes the hero.
  useEffect(() => {
    if (hasDoc) setShowChat(false)
  }, [hasDoc])

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className={cn('min-h-0', hasDoc ? 'flex-1 overflow-y-auto select-text' : 'shrink-0')}>
          {hasDoc ? (
            <div className="mx-auto w-full max-w-3xl px-8 py-6">
              <MarkdownText text={doc} streaming={running} />
            </div>
          ) : (
            <div className="flex items-center gap-2 px-8 pt-6 text-[13px] text-muted-foreground">
              {running && (
                <span className="size-1.5 animate-pulse rounded-full bg-success" />
              )}
              {running ? 'Drafting — the plan document appears here as it is written.' : 'Describe what to plan below.'}
            </div>
          )}
        </div>

        {/* conversation side-channel */}
        <div className={cn('flex min-h-0 flex-col', hasDoc ? 'shrink-0' : 'flex-1', showChat && hasDoc && 'flex-1')}>
          <div className="mx-auto w-full max-w-3xl shrink-0 px-6">
            <button
              onClick={() => setShowChat(!showChat)}
              className="flex items-center gap-1 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <ChevronRight className={cn('size-3 transition-transform', showChat && 'rotate-90')} />
              Conversation
            </button>
          </div>
          <AnimatePresence initial={false}>
            {showChat && (
              <motion.div
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                className="min-h-0 flex-1"
              >
                <Transcript sessionId={session.id} className="h-full overflow-y-auto select-text" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="relative">
        {hasDoc && !running && <StartHandoff session={session} />}
        <PromptBar compact />
      </div>
    </>
  )
}

function StartHandoff({ session }: { session: SessionMeta }): React.JSX.Element {
  const createThread = useApp((s) => s.createThread)
  const send = useApp((s) => s.send)
  const [busy, setBusy] = useState(false)

  const start = async (type: 'implementation' | 'orchestration'): Promise<void> => {
    if (busy || !session.projectId) return
    setBusy(true)
    try {
      const thread = await createThread({
        projectId: session.projectId,
        threadType: type,
        provider: 'claude',
        model: session.model,
        agentType: type === 'orchestration' ? 'orchestrator' : 'implementer',
        planPath: session.planPath ?? undefined,
        title: session.title.replace(/^Plan:?\s*/i, '')
      })
      await send(
        thread.id,
        type === 'implementation'
          ? 'Implement the plan.'
          : 'Orchestrate implementation of the plan across subagents.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 -top-10 flex justify-center">
      <Popover>
        <PopoverTrigger asChild>
          <button className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground shadow-[0_2px_12px_rgb(0_0_0/0.15)] transition-transform hover:scale-[1.02] active:scale-95">
            <Play className="size-3.5 fill-current" />
            Start
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-64 p-1.5">
          <button
            disabled={busy}
            onClick={() => void start('implementation')}
            className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-accent active:scale-[0.99]"
          >
            <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-[13px] font-medium">Implement</span>
              <span className="block text-[11px] text-muted-foreground">One agent works the plan's tasks</span>
            </span>
          </button>
          <button
            disabled={busy}
            onClick={() => void start('orchestration')}
            className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-accent active:scale-[0.99]"
          >
            <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-[13px] font-medium">Orchestrate</span>
              <span className="block text-[11px] text-muted-foreground">Split across subagents in parallel</span>
            </span>
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
