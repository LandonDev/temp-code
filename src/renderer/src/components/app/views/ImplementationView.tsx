import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronRight, Circle, MessageSquare } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { modelInfo } from '@shared/catalog'
import { useApp, type LiveEditState } from '../../../state/store'
import type { Block, TodoItem } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { useNow } from '../../../lib/useNow'
import { EASE_OUT, SPRING_PANEL } from '../../../lib/ease'
import { duration, StatusDot } from '../bits'
import { Spinner } from '../../ui/spinner'
import { AgentDetail, AgentRow, useAgents } from '../AgentFleet'
import { ApprovalCard } from '../blocks/ApprovalCard'
import { QuestionCard } from '../blocks/QuestionCard'
import {
  DiffBlock,
  editModel,
  ErrorChip,
  EDIT_TOOLS,
  parsePatchDiff,
  splitEdit,
  TweenHeight,
  ZEditCard
} from '../blocks/ToolGroup'
import { MarkdownText } from '../blocks/MarkdownText'
import { Transcript } from '../Transcript'
import { WorkingStrip } from '../WorkingStrip'
import { PromptBar } from '../PromptBar'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/**
 * Implementation thread: the CHANGES are the view. The hero surface shows
 * the plan (slim checklist), then every file change as an open diff card
 * streaming in as it happens — plus anything that needs the user (approvals,
 * errors) and the agent's closing report. All other mechanics (thinking,
 * reads, commands, prose) live in the chat panel docked on the right.
 */
const EMPTY_TODOS: TodoItem[] = []
const EMPTY_ROUNDS: TodoItem[][] = []
const EMPTY_COSTS: (number | undefined)[] = []

/** "Aug 16, 9:25 PM" — the pass record's completion stamp, local time. */
const WHEN_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

export function ImplementationView({ session }: { session: SessionMeta }): React.JSX.Element {
  const todos = useApp((s) => s.todos[session.id]) ?? EMPTY_TODOS
  const blocksRaw = useApp((s) => s.blocks[session.id])
  const blocks = useMemo(() => blocksRaw ?? [], [blocksRaw])
  const running = session.status === 'running' || session.status === 'starting'
  const waiting = session.status === 'waiting'

  // Subagents this thread spawned — the fleet rows render under the plan,
  // same surface orchestration uses, without displacing the change stream.
  const sessions = useApp((s) => s.sessions)
  const agents = useAgents(session.id)
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const anyAgentLive = agents.some((a) => a.status === 'running' || a.status === 'starting')
  const agentNow = useNow(anyAgentLive)
  const openAgent = openAgentId ? (sessions[openAgentId] ?? null) : null

  // Rounds (follow-ups): each user request that opened a new turn is its
  // own board section — its todo list, its work, its timers. Nothing
  // bleeds across the idle gap between requests.
  const pastTodosAll = useApp((s) => s.pastTodos[session.id]) ?? EMPTY_ROUNDS
  const pastCosts = useApp((s) => s.pastCosts[session.id]) ?? EMPTY_COSTS
  const stopped = useApp((s) => !!s.stopped[session.id])
  const curRound = pastTodosAll.length
  const rounds = useMemo(() => {
    const list: RoundData[] = Array.from({ length: curRound + 1 }, (_, r) => ({
      todos: r < curRound ? pastTodosAll[r] : todos,
      blocks: [],
      work: [],
      header: null
    }))
    for (const b of blocks) {
      const R = list[Math.min(b.round ?? 0, curRound)]
      R.blocks.push(b)
      if (R.header === null && b.kind === 'user') R.header = b
      if (
        // Bookkeeping-only edits (.temp-code/) aren't work to review.
        (b.kind === 'tool' && EDIT_TOOLS.has(b.name) && splitEdit(b).edits.length > 0) ||
        ((b.kind === 'approval' || b.kind === 'question') && !b.resolved) ||
        b.kind === 'error'
      ) {
        R.work.push(b)
      }
    }
    return list
  }, [blocks, todos, pastTodosAll, curRound])
  const cur = rounds[curRound]

  const allDone = cur.todos.length > 0 && cur.todos.every((t) => t.status === 'completed')
  // The agent's final report renders as the closing note under the work —
  // and a follow-up that produced no task list (a question, a tweak) shows
  // its answer here too, so the board never ends on a bare header.
  const closing = useMemo(() => {
    const last = blocks.at(-1)
    return (allDone || (!running && cur.todos.length === 0)) &&
      last?.kind === 'assistant' &&
      !last.streaming &&
      last.text.trim()
      ? last
      : null
  }, [blocks, allDone, running, cur.todos.length])

  /** user-toggled task bodies — XOR against the round's default (current
   *  round opens, past rounds fold shut when a follow-up starts) */
  const [toggledTasks, setToggledTasks] = useState<Set<string>>(new Set())
  /** past rounds the user expanded back open — resets when a new round
   *  starts, so every new pass begins with history tucked away */
  const [openRounds, setOpenRounds] = useState<Set<number>>(new Set())
  const [sawRound, setSawRound] = useState(curRound)
  if (sawRound !== curRound) {
    setSawRound(curRound)
    setOpenRounds(new Set())
  }
  /** a grid row clicked open: its diff morphs open inside the task */
  const [openChange, setOpenChange] = useState<{
    round: number
    task: number
    path: string
  } | null>(null)

  // Disk changes with no matching harness edit (M23): shell-made work.
  const liveMap = useApp((s) => s.liveEdits[session.id])
  const diskOnly = useMemo(() => {
    if (!liveMap) return []
    const harnessPaths = new Set<string>()
    for (const b of blocks) {
      if (b.kind !== 'tool' || !EDIT_TOOLS.has(b.name)) continue
      for (const eb of splitEdit(b).edits) {
        const p = editModel(eb).path
        if (p) harnessPaths.add(p.split('/').pop() ?? p)
      }
    }
    return Object.values(liveMap).filter(
      (e) =>
        !e.burst &&
        (e.diff || e.state === 'editing') &&
        !harnessPaths.has(e.path.split('/').pop() ?? e.path)
    )
  }, [liveMap, blocks])

  const usageMarks = useApp((s) => s.usage[session.id]) ?? []

  const active = cur.todos.findIndex((t) => t.status === 'in_progress')
  const now = useNow(running && active !== -1)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [session.id])
  const interactingUntil = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current && running && Date.now() > interactingUntil.current) {
      el.scrollTop = el.scrollHeight
    }
  })

  const goal = blocks.find((b) => b.kind === 'user')

  // The view is phased like planning: a plain chat until there is a board
  // to show (tasks or subagents), then a draggable split — board left,
  // conversation right. The chat can fold to an edge bar; a thread stopped
  // on a question forces it open (render-time adjust, not an effect).
  // Once ANY round produced tasks the thread stays a board — a follow-up
  // that needed no task list must not collapse the whole split view.
  const hasBoard = todos.length > 0 || pastTodosAll.some((t) => t.length > 0) || agents.length > 0
  const [chatOpen, setChatOpen] = useState(true)
  const [sawWaiting, setSawWaiting] = useState(waiting)
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting)
    if (waiting) setChatOpen(true)
  }
  // The conversation pane follows the run: a thread that starts working
  // again (follow-up, queued message, waking subagent) reopens it, and the
  // run FINISHING with every task done folds it away again. A user stop
  // (interrupt), a question, or an unfinished plan keeps it open: the
  // user still has to talk.
  const [sawRunning, setSawRunning] = useState(running)
  if (running !== sawRunning) {
    setSawRunning(running)
    if (running) setChatOpen(true)
    else if (!waiting && allDone && !stopped) setChatOpen(false)
  }
  const collapsed = hasBoard && !chatOpen

  // Board/chat split in %, draggable 30–70, double-click resets.
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
  const reduce = useReducedMotion()

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1">
      <AnimatePresence initial={false}>
        {hasBoard && (
          <motion.div
            key="board"
            initial={reduce ? false : { flexBasis: '0%', opacity: 0 }}
            animate={{ flexBasis: collapsed ? '100%' : `${split}%`, opacity: 1 }}
            transition={dragging || reduce ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT }}
            style={{ flexGrow: 0, flexShrink: 1 }}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <div
              ref={scrollRef}
              onPointerDown={() => (interactingUntil.current = Date.now() + 1500)}
              className="flex-1 overflow-y-auto select-text"
            >
              <div className="mx-auto w-full max-w-3xl px-6 py-5">
                {goal && (
                  <div className="mb-5">
                    {/* With follow-up rounds, the original request lives in
                        its own collapsed row below — repeating it here would
                        say the same thing twice. The plan pin stays: it is
                        the thread's identity, not a round's. */}
                    {session.planPath ? (
                      <PlanPin session={session} />
                    ) : curRound === 0 ? (
                      <p className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
                        {goal.kind === 'user' && goal.text.split('\n')[0]}
                      </p>
                    ) : null}
                    {curRound === 0 && todos.length > 0 && <ProgressSegments todos={todos} />}
                    <ChangesLine session={session} />
                  </div>
                )}

                {agents.length > 0 && (
                  <div className="mb-5">
                    <p className="mb-1 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                      Subagents
                    </p>
                    <div className="-mx-3 flex flex-col gap-0.5">
                      {agents.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          now={agentNow}
                          hidden={openAgentId === agent.id}
                          onOpen={() => setOpenAgentId(agent.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Previous passes tuck away: each collapses to one row
                (request · tasks · diffstat) in a bordered group, expanding
                in place. A wide gap separates them from the current work,
                which always renders in full. */}
                {curRound > 0 && (
                  <div className="mb-8 divide-y divide-hairline border-y border-hairline">
                    {rounds.slice(0, curRound).map((data, r) => (
                      <RoundSection
                        key={r}
                        session={session}
                        round={r}
                        data={data}
                        isCurrent={false}
                        multi
                        expanded={openRounds.has(r)}
                        onToggle={() =>
                          setOpenRounds((prev) => {
                            const next = new Set(prev)
                            if (next.has(r)) next.delete(r)
                            else next.add(r)
                            return next
                          })
                        }
                        running={running}
                        now={now}
                        pastCosts={pastCosts}
                        marks={usageMarks}
                        diskOnly={diskOnly}
                        openChange={openChange}
                        setOpenChange={setOpenChange}
                        toggled={toggledTasks}
                        setToggled={setToggledTasks}
                      />
                    ))}
                  </div>
                )}
                <RoundSection
                  key={curRound}
                  session={session}
                  round={curRound}
                  data={cur}
                  isCurrent
                  multi={curRound > 0}
                  expanded
                  running={running}
                  now={now}
                  pastCosts={pastCosts}
                  marks={usageMarks}
                  diskOnly={diskOnly}
                  openChange={openChange}
                  setOpenChange={setOpenChange}
                  toggled={toggledTasks}
                  setToggled={setToggledTasks}
                />

                {running && cur.work.length === 0 && (
                  <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" />
                    {cur.todos.length === 0 ? 'Breaking the task down…' : 'Working…'}
                  </div>
                )}

                {closing && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="mt-6 border-t border-border/60 pt-4"
                  >
                    <MarkdownText text={closing.text} streaming={false} />
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {hasBoard && !collapsed && (
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
          {hasBoard && (
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
          <Transcript sessionId={session.id} minimap={!hasBoard} />
          <WorkingStrip sessionId={session.id} />
          <PromptBar compact={hasBoard} narrow={hasBoard} />
        </div>
      )}

      <AnimatePresence>
        {openAgent && (
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

/** One request round: its todo list, its blocks, its work items, and the
 *  user message that opened it. */
interface RoundData {
  todos: TodoItem[]
  blocks: Block[]
  work: Block[]
  header: Block | null
}

/** Working time across a block sequence, in order. Tool calls count their
 *  full run (ts → doneTs); the idle gap BEFORE a user message never counts
 *  — that's the user thinking between a halt and a resume, not the pass
 *  working. A resumed pass therefore shows time spent, not wall time. */
function activeMs(list: Block[], liveNow?: number): number {
  let total = 0
  let prev: number | undefined
  for (const b of list) {
    if (b.ts === undefined) continue
    if (prev !== undefined && b.kind !== 'user') total += Math.max(0, b.ts - prev)
    const end = b.kind === 'tool' ? (b.doneTs ?? b.ts) : b.ts
    prev = Math.max(prev ?? end, end)
  }
  if (liveNow !== undefined && prev !== undefined) total += Math.max(0, liveNow - prev)
  return total
}

/** File blocks under the task in progress at their birth; -1 = before the
 *  round's first list. Indices past a shrunken list clamp to the last. */
function groupByTodo(list: Block[], todoCount: number): Map<number, Block[]> {
  const m = new Map<number, Block[]>()
  for (const b of list) {
    const k = todoCount === 0 ? -1 : b.todo < 0 ? -1 : Math.min(b.todo, todoCount - 1)
    const arr = m.get(k)
    if (arr) arr.push(b)
    else m.set(k, [b])
  }
  return m
}

/** One round's board. The CURRENT round renders in full — (for follow-ups)
 *  the request as a prominent header, then setup work, the task cards, or
 *  the flat work list. PAST rounds tuck away into one collapsed row
 *  (request · tasks done · diffstat) that expands in place. Task bodies
 *  default open on the current round and fold shut on past ones. */
function RoundSection({
  session,
  round,
  data,
  isCurrent,
  multi,
  expanded,
  onToggle,
  running,
  now,
  pastCosts,
  marks,
  diskOnly,
  openChange,
  setOpenChange,
  toggled,
  setToggled
}: {
  session: SessionMeta
  round: number
  data: RoundData
  isCurrent: boolean
  /** the thread has follow-up rounds — headers and separators appear */
  multi: boolean
  expanded: boolean
  onToggle?: () => void
  running: boolean
  now: number
  /** cumulative session cost at each round boundary (pass cost = diff) */
  pastCosts: (number | undefined)[]
  marks: { round: number; todo: number; input?: number; output?: number }[]
  diskOnly: LiveEditState[]
  openChange: { round: number; task: number; path: string } | null
  setOpenChange: (v: { round: number; task: number; path: string } | null) => void
  toggled: Set<string>
  setToggled: React.Dispatch<React.SetStateAction<Set<string>>>
}): React.JSX.Element | null {
  const { todos, blocks, work } = data
  const workByTodo = useMemo(() => groupByTodo(work, todos.length), [work, todos.length])
  const blocksByTodo = useMemo(() => groupByTodo(blocks, todos.length), [blocks, todos.length])
  // Per-todo wall clock from this round's blocks only — a follow-up can
  // never stretch an old task across the idle gap.
  const spans = useMemo(() => {
    const m = new Map<number, { first: number; last: number }>()
    for (const b of blocks) {
      if (b.ts === undefined) continue
      const s = m.get(b.todo)
      if (!s) m.set(b.todo, { first: b.ts, last: b.ts })
      else s.last = b.ts
    }
    return m
  }, [blocks])
  const roundMarks = useMemo(() => marks.filter((m) => m.round === round), [marks, round])
  const preWork = todos.length ? (workByTodo.get(-1) ?? []) : []
  const flatWork = todos.length === 0 ? (workByTodo.get(-1) ?? []) : []

  // Shell-made changes file under the task that was running when the edit
  // began: the last task started before it, kept only if the edit falls
  // inside that task's span (the live tail stays open-ended).
  const shellByTask = useMemo(() => {
    const m = new Map<number, LiveEditState[]>()
    const entries = [...spans.entries()]
      .filter(([i]) => i >= 0)
      .sort((a, b) => a[1].first - b[1].first)
    if (entries.length === 0) return m
    for (const e of diskOnly) {
      let owner: number | null = null
      for (const [i, s] of entries) {
        if (e.startedTs >= s.first - 1500) owner = i
      }
      if (owner === null) continue
      const s = spans.get(owner)!
      const openEnded = isCurrent && running && owner === entries[entries.length - 1][0]
      if (openEnded || e.startedTs <= s.last + 3000) {
        const arr = m.get(owner)
        if (arr) arr.push(e)
        else m.set(owner, [e])
      }
    }
    return m
  }, [diskOnly, spans, isCurrent, running])

  const done = todos.filter((t) => t.status === 'completed').length
  const stat = useMemo(() => {
    let adds = 0
    let dels = 0
    for (const b of work) {
      if (b.kind !== 'tool' || !EDIT_TOOLS.has(b.name)) continue
      for (const eb of splitEdit(b).edits) {
        const m = editModel(eb)
        adds += m.adds
        dels += m.dels
      }
    }
    return { adds, dels }
  }, [work])
  const headerText = data.header?.kind === 'user' ? data.header.text.split('\n')[0] : ''

  // A round with nothing on the board (a pure Q&A pass) has no row to earn.
  if (multi && !isCurrent && todos.length === 0 && work.length === 0) return null

  const body = (
    <>
      {preWork.length > 0 && (
        <div className="mb-4">
          {round === 0 && (
            <p className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground/70 uppercase">
              Setup
            </p>
          )}
          <WorkItems blocks={preWork} sessionId={session.id} />
        </div>
      )}

      {todos.length > 0 && (
        <div className="mb-5 flex flex-col">
          {todos.map((todo, i) => {
            const key = `${round}:${i}`
            const span = spans.get(i)
            const live = isCurrent && running && todo.status === 'in_progress'
            const taskBlocks = blocksByTodo.get(i) ?? []
            const ms =
              todo.status === 'pending' ? null : activeMs(taskBlocks, live ? now : undefined)
            const items = workByTodo.get(i) ?? []
            const needsUser = items.some(
              (b) => (b.kind === 'approval' || b.kind === 'question') && !b.resolved
            )
            const folded = todo.status === 'completed' && !needsUser
            const bodyOpen = toggled.has(key) ? !isCurrent : isCurrent
            return (
              <div
                key={key}
                className={cn(
                  'mb-2 overflow-hidden rounded-[10px] transition-colors duration-150',
                  live ? 'bg-accent/70 hover:bg-accent' : 'bg-accent/35 hover:bg-accent/60'
                )}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    setToggled((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                  className="cursor-pointer px-2 pt-0.5"
                >
                  <TodoRow
                    content={todo.content}
                    status={todo.status}
                    live={live}
                    ms={ms !== null && ms > 1500 ? ms : null}
                  />
                </div>
                <TweenHeight open={bodyOpen} animate>
                  <div>
                    {live && <TaskActivity blocks={taskBlocks} />}
                    {(items.length > 0 || (folded && shellByTask.has(i))) &&
                      (folded ? (
                        <TaskGrid
                          blocks={taskBlocks}
                          shell={shellByTask.get(i)}
                          openPath={
                            openChange?.round === round && openChange.task === i
                              ? openChange.path
                              : null
                          }
                          onPick={(path) =>
                            setOpenChange(
                              openChange?.round === round &&
                                openChange.task === i &&
                                openChange.path === path
                                ? null
                                : { round, task: i, path }
                            )
                          }
                        />
                      ) : (
                        <div className="px-3 pt-1 pb-2">
                          <WorkItems blocks={items} sessionId={session.id} />
                        </div>
                      ))}
                    {live && (shellByTask.get(i)?.length ?? 0) > 0 && (
                      <DiskCards edits={shellByTask.get(i)!} />
                    )}
                    {(live || todo.status === 'completed') && (
                      <TaskMeta
                        index={i}
                        blocks={taskBlocks}
                        marks={roundMarks}
                        span={span}
                        live={live}
                        now={now}
                      />
                    )}
                  </div>
                </TweenHeight>
              </div>
            )
          })}
        </div>
      )}

      {flatWork.length > 0 && (
        <div className="mb-4">
          <WorkItems blocks={flatWork} sessionId={session.id} />
        </div>
      )}
    </>
  )

  // A previous pass: "Pass N" leading its request, with the run's record
  // underneath — when it finished, how long it took, what ran it (model ·
  // effort · window, on logs that stamp them) and what it cost — expanding
  // in place to the full board.
  if (multi && !isCurrent) {
    const endTs = blocks.findLast((b) => b.ts !== undefined)?.ts
    const header = data.header?.kind === 'user' ? data.header : null
    const cost = (() => {
      const end = pastCosts[round]
      if (end === undefined) return undefined
      const prev = pastCosts
        .slice(0, round)
        .filter((c): c is number => c !== undefined)
        .at(-1)
      return end - (prev ?? 0)
    })()
    const meta: string[] = []
    if (endTs !== undefined) meta.push(WHEN_FMT.format(endTs))
    const worked = activeMs(blocks)
    if (worked > 1000) meta.push(duration(worked))
    if (header?.model) {
      meta.push(modelInfo(session.provider, header.model)?.label ?? header.model)
      if (header.reasoning) {
        meta.push(header.reasoning[0].toUpperCase() + header.reasoning.slice(1))
      }
      meta.push(header.context1m ? '1M' : '200k')
    }
    if (cost !== undefined && cost > 0.005) meta.push(`$${cost.toFixed(2)}`)
    return (
      <div>
        <button
          onClick={onToggle}
          className="group/round flex w-full items-start gap-2.5 py-2 text-left"
        >
          <ChevronRight
            className={cn(
              'mt-[3px] size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="shrink-0 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
                Pass {round + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground transition-colors group-hover/round:text-foreground">
                {headerText}
              </span>
              {todos.length > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                  {done}/{todos.length} tasks
                </span>
              )}
              {(stat.adds > 0 || stat.dels > 0) && (
                <span className="shrink-0 text-[11px] font-semibold tabular-nums">
                  {stat.adds > 0 && <span className="text-success">+{stat.adds}</span>}{' '}
                  {stat.dels > 0 && <span className="text-destructive">−{stat.dels}</span>}
                </span>
              )}
            </span>
            {meta.length > 0 && (
              <span className="mt-0.5 block truncate text-[11px] tabular-nums text-muted-foreground/55">
                {meta.join(' · ')}
              </span>
            )}
          </span>
        </button>
        <TweenHeight open={expanded} animate>
          <div className="pt-1 pb-2 pl-6">{body}</div>
        </TweenHeight>
      </div>
    )
  }

  // The current pass: full size, its request as the working headline.
  return (
    <div>
      {multi && headerText && (
        <div className="mb-4">
          <p className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{headerText}</p>
          {todos.length > 0 && <ProgressSegments todos={todos} />}
        </div>
      )}
      {body}
    </div>
  )
}

/** The work stream for one group, in birth order. */
function WorkItems({
  blocks,
  sessionId
}: {
  blocks: Block[]
  sessionId: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b) =>
        b.kind === 'approval' ? (
          <ApprovalCard key={b.id} block={b} sessionId={sessionId} />
        ) : b.kind === 'question' ? (
          <QuestionCard key={b.id} block={b} sessionId={sessionId} />
        ) : b.kind === 'error' ? (
          <ErrorChip key={b.id} text={b.text} />
        ) : (
          <FreshEdit key={b.id} block={b as ToolBlock} sessionId={sessionId} />
        )
      )}
    </div>
  )
}

/** Edit cards land open — the diff IS the content here, not a detail.
 *  One card per file, never collapsed behind "+N more". */
function FreshEdit({
  block,
  sessionId
}: {
  block: ToolBlock
  sessionId: string
}): React.JSX.Element {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
      {splitEdit(block).edits.map((eb) => (
        // Auto mode: open exactly while the edit streams, chip when done.
        <ZEditCard key={eb.id} b={eb} sessionId={sessionId} dense />
      ))}
    </motion.div>
  )
}

/** One tick per todo — the progress reads as a shape, not a number. */
function ProgressSegments({
  todos
}: {
  todos: { status: 'pending' | 'in_progress' | 'completed' }[]
}): React.JSX.Element {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div
      className="mt-2.5 flex h-[3px] max-w-72 gap-[3px]"
      role="img"
      aria-label={`${done} of ${todos.length} tasks done`}
    >
      {todos.map((t, i) => (
        <span
          key={i}
          className={cn(
            'min-w-0 flex-1 rounded-full transition-colors duration-300',
            t.status === 'completed'
              ? 'bg-success'
              : t.status === 'in_progress'
                ? 'animate-pulse bg-success/35'
                : 'bg-border'
          )}
        />
      ))}
    </div>
  )
}

/** The blast radius: working-tree diffstat, click-through to the Changes rail. */
function ChangesLine({ session }: { session: SessionMeta }): React.JSX.Element | null {
  const changes = useApp((s) => (session.projectId ? s.changes[session.projectId] : undefined))
  const fetchChanges = useApp((s) => s.fetchChanges)
  const setRailOpen = useApp((s) => s.setRailOpen)
  const idle = session.status === 'idle'

  // Refresh when the turn settles — that's when edits have landed.
  useEffect(() => {
    if (session.projectId) void fetchChanges(session.projectId)
  }, [session.projectId, idle, fetchChanges])

  if (!changes?.length) return null
  const adds = changes.reduce((n, c) => n + c.adds, 0)
  const dels = changes.reduce((n, c) => n + c.dels, 0)
  return (
    <button
      onClick={() => setRailOpen(true)}
      className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
    >
      {changes.length} {changes.length === 1 ? 'file' : 'files'}
      <span className="text-success">+{adds}</span>
      <span className="text-destructive">−{dels}</span>
    </button>
  )
}

/** Slim plan row: status glyph, title, wall clock. The work lives below —
 *  rows carry state, never traces. */
function TodoRow({
  content,
  status,
  live,
  ms
}: {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** in_progress AND the session is actually running — spinner-worthy */
  live: boolean
  ms: number | null
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-2 py-[5px]',
        live
          ? 'text-foreground'
          : status === 'completed'
            ? 'text-muted-foreground'
            : 'text-muted-foreground/60'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {live ? (
          <Spinner className="size-3.5" />
        ) : status === 'completed' ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Circle className="size-3 text-muted-foreground/40" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[14px] font-medium',
          status === 'completed' && 'text-muted-foreground'
        )}
      >
        {content}
      </span>
      {ms !== null && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
          {duration(ms)}
        </span>
      )}
    </div>
  )
}

// ── M25: the task board that explains itself ─────────────────────────

const ACT_KINDS: [RegExp, string, string][] = [
  [/^(Read|Glob|NotebookRead|fs\.read)$/i, 'read', 'files read'],
  [/^Grep$/i, 'search', 'searches'],
  [/^(Bash|shell)$/i, 'command', 'commands'],
  [
    /spawn_agent|wait_for_agent|check_agent|send_to_agent|answer_agent|list_agents/i,
    'subagent',
    'subagent calls'
  ],
  [/^(WebSearch|web_search|WebFetch)$/i, 'web', 'web lookups']
]
const actKind = (name: string): string => {
  if (EDIT_TOOLS.has(name)) return 'edit'
  for (const [re, k] of ACT_KINDS) if (re.test(name)) return k
  return 'tool'
}

/** Live activity summary for the working task — counts, not noise. */
function TaskActivity({ blocks }: { blocks: Block[] }): React.JSX.Element | null {
  const counts = new Map<string, number>()
  for (const b of blocks) {
    if (b.kind !== 'tool') continue
    const k = actKind(b.name)
    if (k === 'edit') continue // edits render as cards below
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const parts = ACT_KINDS.flatMap(([, k, label]) => {
    const n = counts.get(k)
    return n ? [`${n} ${label}`] : []
  })
  const other = counts.get('tool')
  if (other) parts.push(`${other} other tools`)
  if (parts.length === 0) return null
  return (
    <p className="px-4 pb-1 text-[11px] tabular-nums text-muted-foreground/70">
      {parts.join(' · ')}
    </p>
  )
}

/** The WHOLE change a task made to one file: a single edit as-is, several
 *  fused into one synthetic block whose hunks run in call order — clicking
 *  a grid row never shows just the last touch. */
function wholeChange(path: string, edits: ToolBlock[]): ToolBlock {
  if (edits.length === 1) return edits[0]
  const first = edits[0]
  const last = edits[edits.length - 1]
  return {
    ...last,
    id: `${first.id}all`,
    callId: `${first.callId}#all`,
    name: '__merged__',
    input: {
      file_path: path,
      create: editModel(first).create,
      hunks: edits.flatMap((e) => editModel(e).hunks)
    },
    output: last.output ?? '',
    ts: first.ts,
    doneTs: last.doneTs
  }
}

/** A shell-made change as a card the board can open: its unified diff
 *  rides in an apply_patch-shaped block, labeled honestly via the row. */
function diskBlock(e: LiveEditState): ToolBlock {
  return {
    kind: 'tool',
    id: `disk:${e.path}`,
    callId: `disk:${e.path}`,
    name: 'apply_patch',
    input: [
      { path: e.path, diff: e.diff ?? '', kind: { type: e.kind === 'created' ? 'add' : 'update' } }
    ],
    output: 'via shell',
    subCount: 0,
    todo: -1,
    round: 0,
    ts: e.startedTs,
    doneTs: e.ts
  }
}

/** A settled task's footprint: every touched file as a quiet text row —
 *  click one and its diff morphs open in place (AgentDetail-style).
 *  Shell-made changes join the grid as rows marked `shell`. */
function TaskGrid({
  blocks,
  shell,
  openPath,
  onPick
}: {
  blocks: Block[]
  shell?: LiveEditState[]
  openPath: string | null
  onPick: (path: string) => void
}): React.JSX.Element | null {
  const gid = useId()
  const files = new Map<
    string,
    {
      name: string
      adds: number
      dels: number
      ms: number
      edits: ToolBlock[]
      disk?: LiveEditState
    }
  >()
  for (const b of blocks) {
    if (b.kind !== 'tool' || !EDIT_TOOLS.has(b.name)) continue
    for (const eb of splitEdit(b).edits) {
      const m = editModel(eb)
      if (!m.path) continue
      const cur = files.get(m.path) ?? {
        name: m.path.split('/').pop() ?? m.path,
        adds: 0,
        dels: 0,
        ms: 0,
        edits: []
      }
      cur.adds += m.adds
      cur.dels += m.dels
      cur.edits.push(eb)
      if (eb.doneTs !== undefined && eb.ts !== undefined) cur.ms += eb.doneTs - eb.ts
      files.set(m.path, cur)
    }
  }
  for (const e of shell ?? []) {
    if (files.has(e.path)) continue
    files.set(e.path, {
      name: e.path.split('/').pop() ?? e.path,
      adds: e.adds ?? 0,
      dels: e.dels ?? 0,
      ms: e.ts - e.startedTs,
      edits: [],
      disk: e
    })
  }
  if (files.size === 0) return null
  const open = openPath ? files.get(openPath) : null
  // Locked layout: rows keep a stable layoutId (so the diff can morph
  // from/to them) but layoutDependency pins them — motion only re-measures
  // when openPath changes, so unrelated reflows (a task collapsing above)
  // move them rigidly with the page instead of springing them around.
  // The clicked row stays mounted (motion hides the follower itself), so
  // sibling rows never reshuffle; the card's height tweens open below the
  // grid so everything under it slides instead of jumping.
  return (
    <LayoutGroup id={gid}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-x-4 px-4 pb-2">
        {[...files.entries()].map(([path, f]) => (
          <motion.button
            key={path}
            layoutId={`chg-${path}`}
            layoutDependency={openPath}
            transition={SPRING_PANEL}
            onClick={() => onPick(path)}
            title={path}
            className="flex items-center gap-2 py-0.5 text-left text-[12px] transition-colors hover:text-foreground"
          >
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">
              {f.ms > 1500 ? `~${duration(f.ms)}` : ''}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {f.name}
              {f.disk && <span className="ml-1.5 text-[10px] text-muted-foreground/45">shell</span>}
            </span>
            <span className="shrink-0 tabular-nums">
              {f.adds > 0 && <span className="text-success">+{f.adds}</span>}{' '}
              {f.dels > 0 && <span className="text-destructive">−{f.dels}</span>}
            </span>
          </motion.button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {open && openPath && (
          <motion.div
            key={openPath}
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="px-3"
          >
            <motion.div
              layoutId={`chg-${openPath}`}
              layoutDependency={openPath}
              transition={SPRING_PANEL}
              className="py-1"
              // Closing the card IS the collapse: a click on the card's own
              // header row morphs it back to its text row. Inner buttons
              // (edit links, line clicks) keep their normal behavior.
              onClickCapture={(e) => {
                const el = e.target as HTMLElement
                const btn = el.closest('button')
                const card = e.currentTarget.querySelector('.group\\/edit')
                if (btn && card && btn === card.querySelector('button')) {
                  e.preventDefault()
                  e.stopPropagation()
                  onPick(openPath)
                }
              }}
            >
              <ZEditCard
                b={open.disk ? diskBlock(open.disk) : wholeChange(openPath, open.edits)}
                pinnedOpen
                dense
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </LayoutGroup>
  )
}

/** Per-task telemetry: tokens (exact boundary deltas only), compactions,
 *  and the horizontal activity timeline. */
function TaskMeta({
  index,
  blocks,
  marks,
  span,
  live = false,
  now = 0
}: {
  index: number
  blocks: Block[]
  marks: { todo: number; input?: number; output?: number }[]
  span?: { first: number; last: number }
  /** the task is the one working right now — its timeline runs on the clock */
  live?: boolean
  now?: number
}): React.JSX.Element | null {
  // Token delta = last mark inside this task minus last mark before it.
  const end = [...marks].reverse().find((m) => m.todo === index)
  const base = [...marks].reverse().find((m) => m.todo < index)
  const out =
    end?.output !== undefined && base?.output !== undefined && end.output >= base.output
      ? end.output - base.output
      : undefined
  const compactions = blocks.filter((b) => b.kind === 'compaction' && b.phase === 'done').length
  const [hover, setHover] = useState<number | null>(null)
  const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

  // A live task's timeline runs to NOW, not to its last event — the bar
  // keeps growing between events, and the 1s-linear transition on each
  // tick makes the marks glide left instead of stepping.
  const tlEnd = span ? (live ? Math.max(now, span.last) : span.last) : 0
  const dur = span ? tlEnd - span.first : 0
  const ticks =
    dur > 3000
      ? blocks.flatMap((b) => {
          if (b.ts === undefined || b.kind !== 'tool') return []
          const k = actKind(b.name)
          // What THIS mark did — the payload beats the tool name.
          const i = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<
            string,
            unknown
          >
          const raw =
            [i.file_path, i.path, i.command, i.pattern, i.query, i.description].find(
              (v) => typeof v === 'string' && v
            ) ?? ''
          const payload = String(raw).split('/').slice(-2).join('/').slice(0, 60)
          return [
            {
              at: (b.ts - span!.first) / dur,
              k,
              detail: payload ? `${b.name} · ${payload}` : b.name,
              off: b.ts - span!.first
            }
          ]
        })
      : []
  const compactTicks =
    dur > 3000
      ? blocks.flatMap((b) =>
          b.kind === 'compaction' && b.ts !== undefined ? [{ at: (b.ts - span!.first) / dur }] : []
        )
      : []
  const TICK_COLOR: Record<string, string> = {
    read: 'bg-info/60',
    search: 'bg-info/60',
    command: 'bg-warning/60',
    subagent: 'bg-violet/70',
    web: 'bg-info/60',
    edit: 'bg-success/80',
    tool: 'bg-foreground/25'
  }

  if (out === undefined && compactions === 0 && ticks.length === 0) return null
  return (
    <div className="px-4 pb-2">
      {(out !== undefined || compactions > 0) && (
        <p className="text-[10.5px] tabular-nums text-muted-foreground/60">
          {out !== undefined && `${fmtTok(out)} output tokens`}
          {out !== undefined && compactions > 0 && ' · '}
          {compactions > 0 && (
            <span className="text-violet">
              {compactions} compaction{compactions > 1 ? 's' : ''}
            </span>
          )}
        </p>
      )}
      {ticks.length > 1 && (
        <div
          className="relative"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            // Nearest mark to the cursor: the popup names what IT did.
            const rect = e.currentTarget.getBoundingClientRect()
            const x = (e.clientX - rect.left) / rect.width
            let best = -1
            let bestD = 0.03 // within 3% of the bar, else nothing
            ticks.forEach((t, n) => {
              const d = Math.abs(t.at - x)
              if (d < bestD) {
                bestD = d
                best = n
              }
            })
            setHover(best >= 0 ? best : null)
          }}
        >
          <div className="relative mt-1 h-[5px] overflow-hidden rounded-full bg-secondary/50">
            {ticks.map((t, n) => (
              <span
                key={n}
                className={cn(
                  'absolute top-0 h-full w-[3px] rounded-full transition-[left] duration-1000 ease-linear',
                  TICK_COLOR[t.k],
                  hover === n && 'brightness-150'
                )}
                style={{ left: `${Math.min(99, t.at * 100)}%` }}
              />
            ))}
            {compactTicks.map((t, n) => (
              <span
                key={`c${n}`}
                className="absolute top-0 h-full w-[2px] bg-violet transition-[left] duration-1000 ease-linear"
                style={{ left: `${Math.min(99, t.at * 100)}%` }}
              />
            ))}
          </div>
          {/* The popup floats over the bar at the mark — nothing reflows. */}
          {hover !== null && ticks[hover] && (
            <div
              className="pointer-events-none absolute bottom-full z-20 mb-1.5 -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1 text-[11px] whitespace-nowrap shadow-[0_4px_16px_rgb(0_0_0/0.12)]"
              style={{ left: `${Math.min(92, Math.max(8, ticks[hover].at * 100))}%` }}
            >
              <span
                className={cn(
                  'mr-1.5 inline-block size-1.5 rounded-full align-middle',
                  TICK_COLOR[ticks[hover].k]
                )}
              />
              {ticks[hover].detail}
              <span className="ml-1.5 text-muted-foreground/60 tabular-nums">
                {duration(ticks[hover].off)} in
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Shell-made changes the harness never described (M23): disk truth,
 *  labeled as such — never presented as a tool edit. Rows with a diff
 *  expand in place to show it. */
function DiskCards({ edits }: { edits: LiveEditState[] }): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  return (
    <div className="flex flex-col gap-1 px-3 pb-2">
      {edits.slice(0, 20).map((e) => {
        const expandable = !!e.diff
        const isOpen = open.has(e.path)
        return (
          <div key={e.path} className="rounded-[9px] border border-border/50 bg-background/40">
            <button
              disabled={!expandable}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev)
                  if (next.has(e.path)) next.delete(e.path)
                  else next.add(e.path)
                  return next
                })
              }
              className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px]"
            >
              {e.state === 'editing' && <Spinner className="size-3" />}
              <span className="min-w-0 truncate font-medium">{e.path.split('/').pop()}</span>
              <span className="truncate text-[10.5px] text-muted-foreground/60">{e.path}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground/50">via shell</span>
                {(e.adds ?? 0) + (e.dels ?? 0) > 0 && (
                  <span className="text-[11px] font-semibold tabular-nums">
                    {(e.adds ?? 0) > 0 && <span className="text-success">+{e.adds}</span>}{' '}
                    {(e.dels ?? 0) > 0 && <span className="text-destructive">−{e.dels}</span>}
                  </span>
                )}
                {expandable && (
                  <ChevronRight
                    className={cn(
                      'size-3 text-muted-foreground/50 transition-transform duration-200',
                      isOpen && 'rotate-90'
                    )}
                  />
                )}
              </span>
            </button>
            {expandable && (
              <TweenHeight open={isOpen} animate>
                <div className="border-t border-border/50">
                  <DiffBlock rows={parsePatchDiff(e.diff!, e.kind === 'created').rows} dense />
                </div>
              </TweenHeight>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Plan-started threads pin the PLAN, not the kickoff sentence: title,
 *  live tick count, click-through to the document. */
function PlanPin({ session }: { session: SessionMeta }): React.JSX.Element {
  const readFile = useApp((s) => s.readFile)
  const openFileRef = useApp((s) => s.openFileRef)
  const [doc, setDoc] = useState('')
  const running = session.status === 'running' || session.status === 'starting'
  useEffect(() => {
    if (!session.planPath) return
    let alive = true
    const poll = async (): Promise<void> => {
      const c = await readFile(session.planPath!)
      if (alive && c !== null) setDoc(c)
    }
    void poll()
    const t = setInterval(() => void poll(), running ? 4000 : 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [session.planPath, running, readFile])
  const title = doc.match(/^#\s+(.+)$/m)?.[1] ?? session.title
  const done = (doc.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length
  const open = (doc.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length
  return (
    <button
      onClick={() => session.planPath && openFileRef(session.planPath)}
      title="Open the plan document"
      className="group flex w-full items-baseline gap-2 text-left"
    >
      <p className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em] group-hover:underline">
        {title}
      </p>
      {done + open > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {done}/{done + open} ticked
        </span>
      )}
    </button>
  )
}
