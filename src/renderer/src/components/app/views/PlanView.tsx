import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, GitFork, ListChecks, MessageSquare, Play } from 'lucide-react'
import type { ProviderId, Reasoning } from '@shared/catalog'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { EASE_OUT } from '../../../lib/ease'
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, StatusDot, timeAgo } from '../bits'
import { MarkdownText } from '../blocks/MarkdownText'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ModelPicker } from '../ModelPicker'
import { Transcript } from '../Transcript'
import { WorkingStrip } from '../WorkingStrip'
import { PromptBar } from '../PromptBar'

/**
 * Planning thread, in three phases. It opens as a normal chat — the
 * conversation is the whole surface while the plan is being shaped. The
 * moment the plan document has content, the document animates in on the
 * left and the chat continues alongside on the right — an even split, with
 * a draggable divider (double-click resets). Once the plan has handed off,
 * the chat collapses to a slim bar on the right edge; one click brings it
 * back. A thread stopped on a question always forces the chat open.
 * Starting the build lives in the plan pane's header — the plan is what
 * you approve, so that is where its action sits.
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
  const waiting = session.status === 'waiting'
  const reduce = useReducedMotion()

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

  // Chat pane phases: open alongside the plan while the conversation runs;
  // collapsed to the edge bar once the plan has handed off. A pending
  // question always forces it open — answers live in the chat. Both are
  // render-time adjusts (the prevLen pattern above), not effects.
  const [chatOpen, setChatOpen] = useState(true)
  const [sawSpawned, setSawSpawned] = useState(!!spawned)
  if (!!spawned !== sawSpawned) {
    setSawSpawned(!!spawned)
    if (spawned) setChatOpen(false)
  }
  const [sawWaiting, setSawWaiting] = useState(waiting)
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting)
    if (waiting) setChatOpen(true)
  }
  const collapsed = hasDoc && !chatOpen

  // The split: plan pane width in %, even by default, draggable between
  // 30 and 70 (double-click the divider to reset).
  const containerRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(50)
  const [dragging, setDragging] = useState(false)
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    setDragging(true)
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      setSplit(Math.min(70, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100)))
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <AnimatePresence initial={false}>
        {hasDoc && (
          <motion.div
            key="plan"
            initial={reduce ? false : { flexBasis: '0%', opacity: 0 }}
            animate={{ flexBasis: collapsed ? '100%' : `${split}%`, opacity: 1 }}
            transition={dragging || reduce ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT }}
            style={{ flexGrow: 0, flexShrink: 1 }}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            {/* Plan pane header: identity on the left, its action on the
                right — Start until the handoff, then the running thread. */}
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-2 pl-4">
              <span className="flex items-center gap-2 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                Plan
                {tasks.length > 0 && (
                  <span className="font-normal tracking-normal normal-case">
                    {tasks.length} tasks
                  </span>
                )}
              </span>
              {spawned ? (
                <HandoffChip spawned={spawned} />
              ) : (
                <AnimatePresence>
                  {!running && !waiting && (
                    <StartButton key="start" session={session} tasks={tasks} />
                  )}
                </AnimatePresence>
              )}
            </div>
            <div className="relative flex min-h-0 flex-1">
              {collapsed && sections.some((s) => s.heading) && (
                <Outline
                  sections={sections}
                  active={activeSection}
                  onJump={(i) => sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth' })}
                />
              )}
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto select-text">
                <div className="mx-auto w-full max-w-3xl px-6 py-6">
                  {sections.map((s, i) => (
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
                      <MarkdownText
                        text={s.body}
                        streaming={running && i === sections.length - 1}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {hasDoc && !collapsed && (
        <div
          onPointerDown={startDrag}
          onDoubleClick={() => setSplit(50)}
          title="Drag to resize · double-click to reset"
          className={cn(
            'w-[3px] shrink-0 cursor-col-resize bg-hairline transition-colors hover:bg-border-strong',
            dragging && 'bg-border-strong'
          )}
        />
      )}

      {collapsed ? (
        <button
          onClick={() => setChatOpen(true)}
          title="Show conversation"
          aria-label="Show conversation"
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-hairline pt-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <MessageSquare className="size-3.5" />
          <StatusDot status={session.status} />
        </button>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasDoc && (
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-1.5 pl-4">
              <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                Conversation
              </span>
              <button
                onClick={() => setChatOpen(false)}
                title="Hide conversation"
                aria-label="Hide conversation"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
          <Transcript sessionId={session.id} />
          <WorkingStrip sessionId={session.id} />
          <PromptBar compact={hasDoc} narrow={hasDoc} />
        </div>
      )}
    </div>
  )
}

/** Heading map down the left edge — only on the full-width plan. */
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

/** After Start: the pane header points at the thread working the plan. */
function HandoffChip({ spawned }: { spawned: SessionMeta }): React.JSX.Element {
  const select = useApp((s) => s.select)
  const type = spawned.threadType ?? 'implementation'
  const Glyph = THREAD_GLYPHS[type]
  const live = spawned.status === 'running' || spawned.status === 'starting'
  return (
    <button
      onClick={() => void select(spawned.id)}
      className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Glyph className={cn('size-3', THREAD_TINTS[type])} />
      {THREAD_LABELS[type]} {live ? 'running' : 'finished'} · {timeAgo(spawned.updatedAt)}
      <StatusDot status={spawned.status} />
      <ChevronRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

const EFFORT_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** Coordination brief for one of several parallel workers on one plan. */
const workerBrief = (i: number, n: number): string =>
  n === 1
    ? 'Implement the plan.'
    : `Implement the plan. You are worker ${i + 1} of ${n} working this plan in parallel. Coordinate ONLY through the plan file's ## Tasks checklist: re-read the plan file before picking each task; skip tasks that are ticked or marked in progress; when you pick one, append "(in progress: worker ${i + 1})" to its line, and replace that marker with a clean tick when done.`

/** The plan pane's one action: hand the approved plan to builders — who
 *  (model + effort), how many, or an orchestrator that splits it itself. */
function StartButton({
  session,
  tasks
}: {
  session: SessionMeta
  tasks: string[]
}): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const createThread = useApp((s) => s.createThread)
  const send = useApp((s) => s.send)
  const [busy, setBusy] = useState(false)
  // The build's model defaults to the planning thread's — change it here.
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string }>({
    provider: session.provider,
    model: session.model
  })
  const [reasoning, setReasoning] = useState<Reasoning>(session.reasoning)
  const [workers, setWorkers] = useState(1)
  const reduce = useReducedMotion()
  const ladder =
    catalog?.[choice.provider]?.models.find((m) => m.id === choice.model)?.reasoning ?? []

  const start = async (type: 'implementation' | 'orchestration'): Promise<void> => {
    if (busy || !session.projectId) return
    setBusy(true)
    try {
      const base = session.title.replace(/^Plan:?\s*/i, '')
      const n = type === 'implementation' ? workers : 1
      for (let i = 0; i < n; i++) {
        const thread = await createThread({
          projectId: session.projectId,
          threadType: type,
          provider: choice.provider,
          model: choice.model,
          reasoning,
          agentType: type === 'orchestration' ? 'orchestrator' : 'implementer',
          planPath: session.planPath ?? undefined,
          title: n > 1 ? `${base} (${i + 1}/${n})` : base
        })
        await send(
          thread.id,
          type === 'implementation'
            ? workerBrief(i, n)
            : 'Orchestrate implementation of the plan across subagents.'
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const withCount = (label: string): string =>
    tasks.length ? `${label} · ${tasks.length} tasks` : label

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
      // The plan settling is a rare, earned moment — a touch of overshoot.
      transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.6 }}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground shadow-[0_1px_6px_rgb(0_0_0/0.12)] transition-transform hover:scale-[1.02] active:scale-95">
            <Play className="size-3 fill-current" />
            Start
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" className="w-80 rounded-xl p-1.5">
          {/* Who builds it: model + effort for the new thread(s). */}
          <div className="flex items-center gap-1 px-1 pt-0.5 pb-1.5">
            <ModelPicker
              provider={choice.provider}
              model={choice.model}
              onPick={(p, m) => {
                setChoice({ provider: p, model: m })
                const next = catalog?.[p].models.find((x) => x.id === m)
                const steps = next?.reasoning ?? []
                if (!steps.includes(reasoning)) {
                  setReasoning(next?.defaultReasoning ?? steps[0] ?? 'medium')
                }
              }}
            />
            {ladder.length > 1 && (
              <Select value={reasoning} onValueChange={(v) => setReasoning(v as Reasoning)}>
                <SelectTrigger size="sm" aria-label="Reasoning effort" className="gap-1 px-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ladder.map((r) => (
                    <SelectItem key={r} value={r}>
                      {EFFORT_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="-mx-1 mb-1 h-px bg-hairline" />
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && void start('implementation')}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void start('implementation')}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent active:scale-[0.99]"
          >
            <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">
                Implement{workers > 1 ? ` × ${workers}` : ''}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {workers > 1
                  ? withCount(`${workers} threads split the plan's tasks`)
                  : withCount("One agent works the plan's tasks")}
              </span>
            </span>
            {/* How many parallel implementation threads. */}
            <span
              onClick={(e) => e.stopPropagation()}
              className="flex shrink-0 gap-0.5 rounded-md bg-secondary/60 p-0.5"
            >
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => setWorkers(n)}
                  aria-label={`${n} thread${n > 1 ? 's' : ''}`}
                  className={cn(
                    'flex size-5 items-center justify-center rounded text-[11px] transition-colors',
                    workers === n
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {n}
                </button>
              ))}
            </span>
          </div>
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
