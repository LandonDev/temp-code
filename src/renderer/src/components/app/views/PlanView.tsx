import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, GitFork, ListChecks, Play } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { EASE_OUT } from '../../../lib/ease'
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, StatusDot, timeAgo } from '../bits'
import { MarkdownText } from '../blocks/MarkdownText'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { QuietChannel } from '../QuietChannel'
import { PromptBar } from '../PromptBar'

/**
 * Planning thread: the plan document IS the view. The agent writes a real
 * file; we poll it and render it section by section — a revised section
 * flashes a violet wash so a live document never mutates silently. An
 * outline gutter tracks the structure on wide windows. The conversation
 * lives in the quiet channel; when the agent stops on a question, the
 * question surfaces as a card right above the prompt bar.
 */

interface Section {
  heading: string | null
  level: number
  body: string
}

/** Split markdown into heading-led sections, ignoring headings in fences. */
function splitSections(md: string): Section[] {
  const out: Section[] = []
  let cur: Section = { heading: null, level: 0, body: '' }
  let fence = false
  const push = (): void => {
    if (cur.body.trim()) out.push(cur)
  }
  for (const line of md.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) fence = !fence
    const m = fence ? null : /^(#{1,3})\s+(.+)/.exec(line)
    if (m) {
      push()
      cur = { heading: m[2].trim(), level: m[1].length, body: line + '\n' }
    } else {
      cur.body += line + '\n'
    }
  }
  push()
  return out
}

/** The plan's task list: items under a heading that smells like tasks. */
function planTasks(sections: Section[]): string[] {
  const sec = sections.find((s) => s.heading && /task|step|milestone/i.test(s.heading))
  if (!sec) return []
  return sec.body
    .split('\n')
    .slice(1)
    .filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+(?:\[.\]\s*)?/, '').trim())
}

export function PlanView({ session }: { session: SessionMeta }): React.JSX.Element {
  const readFile = useApp((s) => s.readFile)
  const [doc, setDoc] = useState<string | null>(null)
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

  const sections = useMemo(() => splitSections(doc ?? ''), [doc])
  const tasks = useMemo(() => planTasks(sections), [sections])
  const hasDoc = sections.length > 0

  // Revision wash: a settled section whose content changed flashes once.
  // The streaming tail (last section while running) is growth, not revision.
  const prevRef = useRef<Section[]>([])
  const [flash, setFlash] = useState<Record<number, number>>({})
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = sections
    if (prev.length === 0) return
    const changed = sections
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => {
        if (running && i >= sections.length - 1) return false
        const p = prev[i]
        return p !== undefined && p.body !== s.body
      })
      .map(({ i }) => i)
    if (changed.length) {
      setFlash((f) => {
        const next = { ...f }
        for (const i of changed) next[i] = (next[i] ?? 0) + 1
        return next
      })
    }
  }, [sections, running])

  // Outline: refs per section, active = last heading above the fold
  // (follows the stream while the agent writes).
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([])
  const [activeSection, setActiveSection] = useState(0)
  // While the agent writes, the outline follows the stream (render-time
  // adjust — a new section arriving moves the highlight to it).
  const [prevLen, setPrevLen] = useState(sections.length)
  if (prevLen !== sections.length) {
    setPrevLen(sections.length)
    if (running) setActiveSection(sections.length - 1)
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      let active = 0
      sectionRefs.current.forEach((ref, i) => {
        if (ref && ref.offsetTop <= el.scrollTop + 96) active = i
      })
      setActiveSection(active)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasDoc])

  // The thread this plan handed off to, once started.
  const spawned = useApp((s) =>
    Object.values(s.sessions).find(
      (x) =>
        x.id !== session.id &&
        x.planPath !== null &&
        x.planPath === session.planPath &&
        x.threadType !== null &&
        x.threadType !== 'planning'
    )
  )
  const question = useApp((s) => {
    if (running) return null
    const blocks = s.blocks[session.id]
    if (!blocks?.length) return null
    const last = blocks.at(-1)
    if (last?.kind !== 'assistant' || !last.text.trim()) return null
    const para =
      last.text
        .trim()
        .split(/\n{2,}/)
        .at(-1) ?? ''
    return para.includes('?') ? para : null
  })

  return (
    <>
      <div className="relative flex min-h-0 flex-1">
        {hasDoc && sections.some((s) => s.heading) && (
          <Outline
            sections={sections}
            active={activeSection}
            onJump={(i) => sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth' })}
          />
        )}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto select-text">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            {spawned && <HandoffLine spawned={spawned} />}
            {hasDoc ? (
              sections.map((s, i) => (
                <div
                  key={`${i}:${flash[i] ?? 0}`}
                  ref={(el) => {
                    sectionRefs.current[i] = el
                  }}
                  className={cn(
                    '-mx-3 rounded-lg px-3 text-[13px]',
                    (flash[i] ?? 0) > 0 && 'animate-[z-plan-wash_1.4s_ease-out]'
                  )}
                >
                  <MarkdownText text={s.body} streaming={running && i === sections.length - 1} />
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                {running && <span className="size-1.5 animate-pulse rounded-full bg-success" />}
                {running ? 'Drafting the plan…' : 'Describe what to plan below.'}
              </div>
            )}
          </div>
        </div>
      </div>

      <QuietChannel sessionId={session.id} label="Conversation" />

      <div className="relative">
        <AnimatePresence>
          {hasDoc && !running && !spawned && <StartHandoff session={session} tasks={tasks} />}
        </AnimatePresence>
        <AnimatePresence>{question && <QuestionCard key="q" text={question} />}</AnimatePresence>
        <PromptBar compact />
      </div>
    </>
  )
}

/** Heading map down the left edge — only where the window has the room. */
function Outline({
  sections,
  active,
  onJump
}: {
  sections: Section[]
  active: number
  onJump: (i: number) => void
}): React.JSX.Element {
  return (
    <nav className="absolute top-6 bottom-4 left-4 hidden w-44 overflow-y-auto min-[1360px]:block">
      <div className="flex flex-col gap-px">
        {sections.map((s, i) =>
          s.heading === null ? null : (
            <button
              key={i}
              onClick={() => onJump(i)}
              className={cn(
                'truncate rounded px-1.5 py-1 text-left text-[11px] leading-4 transition-colors',
                s.level >= 3 && 'pl-4',
                s.level === 2 && 'pl-2.5',
                i === active
                  ? 'text-foreground'
                  : 'text-muted-foreground/60 hover:text-muted-foreground'
              )}
            >
              {s.heading}
            </button>
          )
        )}
      </div>
    </nav>
  )
}

/** After Start: the plan becomes the reference doc for the work in flight. */
function HandoffLine({ spawned }: { spawned: SessionMeta }): React.JSX.Element {
  const select = useApp((s) => s.select)
  const type = spawned.threadType ?? 'implementation'
  const Glyph = THREAD_GLYPHS[type]
  const live = spawned.status === 'running' || spawned.status === 'starting'
  return (
    <button
      onClick={() => void select(spawned.id)}
      className="group mb-5 flex items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <Glyph className={cn('size-3', THREAD_TINTS[type])} />
      {THREAD_LABELS[type]} {live ? 'running' : 'finished'} · {timeAgo(spawned.updatedAt)}
      <StatusDot status={spawned.status} />
      <ChevronRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

/** The agent stopped on a question — surface it; the prompt bar below answers. */
function QuestionCard({ text }: { text: string }): React.JSX.Element {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.25, ease: EASE_OUT }}
      className="mx-auto w-full max-w-3xl px-6 pb-1"
    >
      <div className="rounded-xl border border-violet/25 bg-violet/[0.05] px-4 py-3">
        <p className="text-[10px] font-semibold tracking-[0.08em] text-violet uppercase">
          Needs your answer
        </p>
        <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>
    </motion.div>
  )
}

function StartHandoff({
  session,
  tasks
}: {
  session: SessionMeta
  tasks: string[]
}): React.JSX.Element {
  const createThread = useApp((s) => s.createThread)
  const send = useApp((s) => s.send)
  const [busy, setBusy] = useState(false)
  const reduce = useReducedMotion()

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

  const withCount = (label: string): string =>
    tasks.length ? `${label} · ${tasks.length} tasks` : label

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, y: 8, scale: 0.9 }}
      // The plan settling is a rare, earned moment — a touch of overshoot.
      transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.6 }}
      className="pointer-events-none absolute inset-x-0 -top-10 z-10 flex justify-center"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground shadow-[0_2px_12px_rgb(0_0_0/0.15)] transition-transform hover:scale-[1.02] active:scale-95">
            <Play className="size-3.5 fill-current" />
            Start
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-72 rounded-xl p-1.5">
          <button
            disabled={busy}
            onClick={() => void start('implementation')}
            className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent active:scale-[0.99]"
          >
            <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-[13px] font-medium">Implement</span>
              <span className="block text-[11px] text-muted-foreground">
                {withCount("One agent works the plan's tasks")}
              </span>
            </span>
          </button>
          <button
            disabled={busy}
            onClick={() => void start('orchestration')}
            className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent active:scale-[0.99]"
          >
            <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block text-[13px] font-medium">Orchestrate</span>
              <span className="block text-[11px] text-muted-foreground">
                {withCount('Split across subagents in parallel')}
              </span>
            </span>
          </button>
          {tasks.length > 0 && (
            <>
              <div className="-mx-1 my-1 h-px bg-hairline" />
              <div className="px-2.5 pt-1 pb-1.5">
                {tasks.slice(0, 3).map((t, i) => (
                  <p key={i} className="truncate text-[11px] leading-[18px] text-muted-foreground">
                    {i + 1}. {t}
                  </p>
                ))}
                {tasks.length > 3 && (
                  <p className="text-[11px] leading-[18px] text-muted-foreground/60">
                    +{tasks.length - 3} more
                  </p>
                )}
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </motion.div>
  )
}
