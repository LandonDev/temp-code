import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GitFork,
  ListChecks,
  MessageSquare,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  X
} from 'lucide-react'
import type { ProviderId, Reasoning } from '@shared/catalog'
import type { PermissionPolicy, SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { EASE_OUT } from '../../../lib/ease'
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, StatusDot, timeAgo } from '../bits'
import { MarkdownText } from '../blocks/MarkdownText'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../../ui/select'
import { ModelPicker } from '../ModelPicker'
import { OrchestrationTune, tuneSummary } from '../OrchestrationTune'
import type { ThreadRules } from '@shared/rules'
import { Spinner } from '../../ui/spinner'
import { Transcript } from '../Transcript'
import { WorkingStrip } from '../WorkingStrip'
import { PromptBar } from '../PromptBar'
import { FleetPanel, FleetPulseLine } from '../AgentFleet'

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

  // A doc landing right after mount is a restored plan (the async file
  // poll answering), not a live first write — it must appear instantly.
  // The growth animation reflows both panes every frame, and on a project
  // switch it lands mid sidebar-slide and judders everything. Only a doc
  // born later (the agent writing it while you watch) animates in.
  const mountedAt = useRef(performance.now())
  const liveEntry = performance.now() - mountedAt.current > 800

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
  // collapsed to the edge bar once the plan has handed off, and once the
  // turn settles with the plan written — the plan is the deliverable, the
  // chat is a click away. A pending question always forces it open —
  // answers live in the chat. All are render-time adjusts (the prevLen
  // pattern above), not effects, so a manual toggle wins until the next
  // phase change.
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
  const settledDoc = hasDoc && session.status === 'idle'
  const [sawSettledDoc, setSawSettledDoc] = useState(settledDoc)
  if (settledDoc !== sawSettledDoc) {
    setSawSettledDoc(settledDoc)
    if (settledDoc) setChatOpen(false)
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
            initial={reduce || !liveEntry ? false : { flexBasis: '0%', opacity: 0 }}
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
          {/* No minimap in the side pane — it overlaps the text there. */}
          <Transcript sessionId={session.id} minimap={!hasDoc} />
          <FleetPulseLine sessionId={session.id} />
          <WorkingStrip sessionId={session.id} />
          <PromptBar compact={hasDoc} narrow={hasDoc} />
        </div>
      )}

      {/* Recon fleet: planning threads spawn explorers — same panel the
          chat grows, folded to its edge tab once the fleet settles. */}
      <FleetPanel sessionId={session.id} />
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

const PERMISSION_LABELS: Record<PermissionPolicy, string> = {
  safe: 'Ask first',
  edits: 'Auto-edits',
  auto: 'Full access'
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
const workerBrief = (i: number, n: number, title?: string): string =>
  n === 1
    ? `Implement the plan${title ? ` "${title}"` : ''}.`
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
  const [busy, setBusy] = useState<'implementation' | 'orchestration' | null>(null)
  // The build's setup defaults to the planning thread's — change it here.
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string }>({
    provider: session.provider,
    model: session.model
  })
  const [reasoning, setReasoning] = useState<Reasoning>(session.reasoning)
  // Context window seeds from the planning thread's; only meaningful for
  // claude models with a 1M-capable window (same rule as PromptBar).
  const [ctx1m, setCtx1m] = useState(session.context1m)
  const [permission, setPermission] = useState<PermissionPolicy>(session.permission)
  const [workers, setWorkers] = useState(1)
  // The build's finish line, derived from the plan; editable, clearable —
  // empty starts the thread with no goal.
  const [goal, setGoal] = useState(
    tasks.length > 0
      ? "Every task in the plan's checklist is checked off and typecheck passes"
      : 'The plan is fully implemented and typecheck passes'
  )
  // Orchestration options: per-run instructions + conduct overrides on
  // top of the Settings defaults, swapped into this popover in place.
  const [view, setView] = useState<'main' | 'tune'>('main')
  const [tune, setTune] = useState<ThreadRules>({})
  const workspaceId = useApp((s) =>
    session.projectId
      ? (s.projects.find((p) => p.id === session.projectId)?.workspaceId ?? null)
      : null
  )
  const reduce = useReducedMotion()
  const picked = catalog?.[choice.provider]?.models.find((m) => m.id === choice.model)
  const ladder = picked?.reasoning ?? []
  const model1m = choice.provider === 'claude' && (picked?.context ?? 0) >= 1_000_000

  const start = async (type: 'implementation' | 'orchestration'): Promise<void> => {
    if (busy || !session.projectId) return
    setBusy(type)
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
          permission,
          context1m: model1m && ctx1m,
          agentType: type === 'orchestration' ? 'orchestrator' : 'implementer',
          planPath: session.planPath ?? undefined,
          goal: goal.trim() || undefined,
          title: n > 1 ? `${base} (${i + 1}/${n})` : base,
          ...(type === 'orchestration' && (tune.conduct || tune.instructions?.trim())
            ? { threadRules: tune }
            : {})
        })
        await send(
          thread.id,
          type === 'implementation'
            ? workerBrief(i, n, base)
            : 'Orchestrate implementation of the plan across subagents.'
        )
      }
    } finally {
      setBusy(null)
    }
  }

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
        <PopoverContent align="end" side="bottom" className="w-[340px] gap-0 p-0">
          {view === 'tune' ? (
            <div className="p-3">
              <div className="mb-2 flex items-center gap-1">
                <button
                  onClick={() => setView('main')}
                  aria-label="Back"
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="text-[13px] font-medium">Orchestration options</span>
              </div>
              <OrchestrationTune workspaceId={workspaceId} value={tune} onChange={setTune} />
              <button
                disabled={busy !== null}
                onClick={() => void start('orchestration')}
                className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60"
              >
                {busy === 'orchestration' ? <Spinner className="size-3.5" /> : 'Orchestrate'}
              </button>
            </div>
          ) : (
            <>
              {/* Who builds it, and under what rules — the same knobs a new
              chat gets: model, effort, access. */}
              <div className="border-b border-border/60 px-3 pt-2.5 pb-2">
                <p className="text-[13px] font-medium">
                  Start building
                  {tasks.length > 0 && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {tasks.length} tasks
                    </span>
                  )}
                </p>
                <div className="mt-1.5 -ml-1 flex flex-wrap items-center gap-0.5">
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
                    <Select
                      value={reasoning}
                      onValueChange={(v) => {
                        // The window rows share this menu but not its value —
                        // picking one sets the build's window, effort stays.
                        if (v === 'ctx:std' || v === 'ctx:1m') {
                          setCtx1m(v === 'ctx:1m')
                          return
                        }
                        setReasoning(v as Reasoning)
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Reasoning effort"
                        className="gap-1 px-1.5"
                      >
                        {EFFORT_LABELS[reasoning]}
                        {model1m && `, ${ctx1m ? '1M' : '200k'}`}
                      </SelectTrigger>
                      <SelectContent>
                        {ladder.map((r) => (
                          <SelectItem key={r} value={r}>
                            {EFFORT_LABELS[r]}
                          </SelectItem>
                        ))}
                        {model1m && (
                          <>
                            <SelectSeparator />
                            <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/60 uppercase">
                              Context window
                            </div>
                            {(
                              [
                                ['ctx:std', 'Standard · 200k', !ctx1m],
                                ['ctx:1m', '1M', ctx1m]
                              ] as const
                            ).map(([v, label, on]) => (
                              <SelectItem
                                key={v}
                                value={v}
                                className={cn(!on && 'text-muted-foreground')}
                              >
                                {label}
                                {on && (
                                  <span className="pointer-events-none absolute top-1/2 right-2 flex size-3.5 -translate-y-1/2 items-center justify-center">
                                    <Check className="size-3.5" />
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                  <Select
                    value={permission}
                    onValueChange={(v) => setPermission(v as PermissionPolicy)}
                  >
                    <SelectTrigger size="sm" aria-label="Access" className="gap-1 px-1.5">
                      <ShieldCheck className="size-3 text-muted-foreground" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PERMISSION_LABELS) as PermissionPolicy[]).map((p) => (
                        <SelectItem key={p} value={p}>
                          {PERMISSION_LABELS[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* The finish line the build works toward — clear it to
                  start without a goal. */}
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                <Target
                  className={cn(
                    'size-3.5 shrink-0',
                    goal.trim() ? 'text-primary' : 'text-muted-foreground/60'
                  )}
                />
                <input
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Goal — keep working until… (optional)"
                  aria-label="Goal"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
                />
                {goal && (
                  <button
                    onClick={() => setGoal('')}
                    aria-label="Clear goal"
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition hover:text-foreground active:scale-95"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>

              <div className="p-1">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void start('implementation')}
                  onKeyDown={(e) => e.key === 'Enter' && void start('implementation')}
                  className={cn(
                    'group/act flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-accent active:scale-[0.99]',
                    busy && 'pointer-events-none opacity-60'
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] transition-transform duration-150 group-hover/act:scale-105">
                    {busy === 'implementation' ? (
                      <Spinner className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ListChecks className="size-4 text-success/80" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">
                      Implement{workers > 1 ? ` × ${workers}` : ''}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {workers > 1
                        ? `${workers} threads split the plan's tasks`
                        : "One agent works the plan's tasks"}
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
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => busy === null && void start('orchestration')}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && busy === null && void start('orchestration')
                  }
                  className={cn(
                    'group/act flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-accent active:scale-[0.99]',
                    busy !== null && 'pointer-events-none opacity-60'
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] transition-transform duration-150 group-hover/act:scale-105">
                    {busy === 'orchestration' ? (
                      <Spinner className="size-3.5 text-muted-foreground" />
                    ) : (
                      <GitFork className="size-4 text-violet/80" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">Orchestrate</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {tuneSummary(tune) ?? 'Split across subagents in parallel'}
                    </span>
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setView('tune')
                    }}
                    title="Instructions & rule overrides"
                    aria-label="Orchestration options"
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background/60 hover:text-foreground active:scale-95',
                      tuneSummary(tune) ? 'opacity-100' : 'opacity-0 group-hover/act:opacity-100'
                    )}
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                </div>
              </div>

              {tasks.length > 0 && (
                <div className="rounded-b-xl border-t border-border/60 bg-muted/40 px-3 pt-1.5 pb-2">
                  {tasks.slice(0, 3).map((t, i) => (
                    <p
                      key={i}
                      className="truncate text-[11px] leading-[18px] text-muted-foreground"
                    >
                      {i + 1}. {t}
                    </p>
                  ))}
                  {tasks.length > 3 && (
                    <p className="text-[11px] leading-[18px] text-muted-foreground/60">
                      +{tasks.length - 3} more
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
    </motion.div>
  )
}
