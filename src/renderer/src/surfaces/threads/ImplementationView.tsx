import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { OpenFileFn } from "../../lib/search";
import { EASE_OUT, SPRING_PANEL } from "../../lib/ease";
import { TweenHeight } from "../../motion";
import { FilePreview } from "../../chrome/FilePreview";
import { Check, ChevronRight, Circle } from "../../chrome/icons";
import { usePlanFile } from "../../hooks/usePlanFile";
import { sessionCheckpointStatus, type CheckpointFile } from "../../lib/checkpoint";
import { subscribeGitChanged } from "../../lib/fs";
import { resolveModel } from "../../lib/models";
import type { Block, Session } from "../../lib/session";
import { useLiveEdits, type LiveEditState } from "../../lib/tcserver/store";
import { emptyThread, type TodoItem, type TodoStatus, type UsageMark } from "../../lib/tcserver/todos";
import { isLiveStatus, useAgents } from "../../lib/threads/agents";
import { planHeading, planProgress } from "../../lib/threads/planDoc";
import {
  ACT_KINDS,
  actKind,
  activeMs,
  changeStat,
  diskBlock,
  editPath,
  groupByTodo,
  wholeChange,
} from "../../lib/threads/rounds";
import { AgentMarkdown } from "../AgentMarkdown";
import { duration, Spinner, useNow } from "./bits";
import { AgentDetail } from "./fleet/AgentDetail";
import { AgentRow } from "./fleet/AgentRow";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Implementation thread: the CHANGES are the view. The board shows the
 * plan (slim checklist), then every file change as a card streaming in
 * as it happens — plus anything that needs the user (approvals, errors)
 * and the agent's closing report. All other mechanics (thinking, reads,
 * commands, prose) live in the chat column docked on the right.
 */

/** "Aug 16, 9:25 PM" — the pass record's completion stamp, local time. */
const WHEN_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Every pass wears a color, the same one in every thread: pass 1 is
 *  always green, pass 2 sky, and so on around the wheel. */
const PASS_COLORS = [
  "#10b981",
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#f43f5e",
  "#06b6d4",
  "#84cc16",
  "#d946ef",
];
function passColor(passNum: number): string {
  return PASS_COLORS[Math.max(0, passNum - 1) % PASS_COLORS.length];
}

const isError = (b: Block): boolean => b.role === "system" && b.id.startsWith("err:");
const isCompaction = (b: Block): boolean => b.role === "system" && b.text === "Context compacted";
const needsUser = (b: Block): boolean =>
  (!!b.approval && !b.approval.decided) || (!!b.question && b.question.answers === undefined);
/** Bookkeeping-only edits (.temp-code/) aren't work to review. */
const workEdit = (b: Block): boolean => {
  const p = editPath(b);
  return !!p && !p.includes(".temp-code/");
};
const firstLine = (b: Block | null | undefined): string => b?.text.split("\n")[0] ?? "";

type OpenChange = { round: number; task: number; path: string };

export function ImplementationView(props: ThreadViewProps) {
  const { session, composing } = props;
  const thread = session.thread ?? emptyThread();
  const { todos, rounds: pastTodosAll, costs: pastCosts, stopped, usage: usageMarks } = thread;
  const blocks = session.blocks;
  const running = session.status === "running" || session.status === "starting";
  const waiting = session.status === "waiting";

  // Subagents this thread spawned — the fleet rows render under the plan,
  // each morphing open into its detail on click.
  const agents = useAgents(session.id);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const anyAgentLive = agents.some((a) => isLiveStatus(a.status));
  const agentNow = useNow(anyAgentLive);

  // Rounds (follow-ups): each user request that opened a new turn is its
  // own board section — its todo list, its work, its timers. Nothing
  // bleeds across the idle gap between requests.
  const curRound = pastTodosAll.length;
  const rounds = useMemo(() => {
    const list: RoundData[] = Array.from({ length: curRound + 1 }, (_, r) => ({
      todos: r < curRound ? pastTodosAll[r] : todos,
      blocks: [],
      work: [],
      header: null,
    }));
    for (const b of blocks) {
      const R = list[Math.min(b.round ?? 0, curRound)];
      R.blocks.push(b);
      if (R.header === null && b.role === "user") R.header = b;
      if (workEdit(b) || needsUser(b) || isError(b)) R.work.push(b);
    }
    return list;
  }, [blocks, todos, pastTodosAll, curRound]);
  const cur = rounds[curRound];

  // Passes number by what the board SHOWS — a pure Q&A round has no row
  // and consumes no number. Colors key off this number too.
  const passNums = useMemo(() => {
    let n = 0;
    return rounds.map((r) => (r.todos.length > 0 || r.work.length > 0 ? ++n : 0));
  }, [rounds]);
  const passNum = passNums[curRound] || Math.max(0, ...passNums);

  const allDone = cur.todos.length > 0 && cur.todos.every((t) => t.status === "completed");
  // The agent's final report renders as the closing note under the work —
  // and a follow-up that produced no task list shows its answer here too,
  // so the board never ends on a bare header.
  const closing = useMemo(() => {
    const last = blocks[blocks.length - 1];
    return (allDone || (!running && cur.todos.length === 0)) &&
      last?.role === "assistant" &&
      !last.streaming &&
      last.text.trim()
      ? last
      : null;
  }, [blocks, allDone, running, cur.todos.length]);

  /** user-toggled task bodies — XOR against the round's default */
  const [toggledTasks, setToggledTasks] = useState<Set<string>>(new Set());
  /** past rounds the user expanded back open — resets when a new round starts */
  const [openRounds, setOpenRounds] = useState<Set<number>>(new Set());
  const [sawRound, setSawRound] = useState(curRound);
  if (sawRound !== curRound) {
    setSawRound(curRound);
    setOpenRounds(new Set());
  }
  /** a grid row clicked open: its diff opens inside the task */
  const [openChange, setOpenChange] = useState<OpenChange | null>(null);

  // Disk changes with no matching harness edit: shell-made work. A change
  // only counts as THIS thread's if it began inside one of the thread's
  // own tool windows — a shell command running, or a subagent working.
  const liveMap = useLiveEdits(session.id);
  const diskOnly = useMemo(() => {
    const harnessPaths = new Set<string>();
    const windows: { from: number; to: number }[] = [];
    for (const b of blocks) {
      if (b.role !== "tool") continue;
      const p = editPath(b);
      if (p) harnessPaths.add(p.split("/").pop() ?? p);
      if (b.ts === undefined) continue;
      const k = actKind(b);
      if (k === "command" || k === "subagent") {
        windows.push({
          from: b.ts - 1500,
          to: b.doneTs === undefined ? Number.MAX_SAFE_INTEGER : b.doneTs + 2500,
        });
      }
    }
    return Object.values(liveMap).filter(
      (e) =>
        !e.burst &&
        (e.diff || e.state === "editing") &&
        !harnessPaths.has(e.path.split("/").pop() ?? e.path) &&
        windows.some((w) => e.startedTs >= w.from && e.startedTs <= w.to),
    );
  }, [liveMap, blocks]);

  const active = cur.todos.findIndex((t) => t.status === "in_progress");
  const now = useNow(running && active !== -1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [session.id]);
  const interactingUntil = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current && running && Date.now() > interactingUntil.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const goal = blocks.find((b) => b.role === "user");
  const reduce = useReducedMotion();

  // A plain chat until there is a board to show (tasks or subagents), then
  // a split — board left, conversation right. Once ANY round produced
  // tasks the thread stays a board.
  const hasBoard = todos.length > 0 || pastTodosAll.some((t) => t.length > 0) || agents.length > 0;
  // Returning to a finished thread lands on the board alone — the chat
  // starts folded. `loaded` covers first loads that mount before the
  // backlog hydrates.
  const settled = !running && !waiting && allDone && !stopped;
  const loaded = blocks.length > 0;
  const [chatOpen, setChatOpen] = useState(!(loaded && settled));
  const [sawLoaded, setSawLoaded] = useState(loaded);
  if (loaded !== sawLoaded) {
    setSawLoaded(loaded);
    if (loaded && settled) setChatOpen(false);
  }
  const [sawWaiting, setSawWaiting] = useState(waiting);
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting);
    if (waiting) setChatOpen(true);
  }
  // The conversation follows the run: starting again reopens it, and the
  // run FINISHING with every task done folds it away. A stop, a question,
  // or an unfinished plan keeps it open: the user still has to talk.
  const [sawRunning, setSawRunning] = useState(running);
  if (running !== sawRunning) {
    setSawRunning(running);
    if (running) setChatOpen(true);
    else if (!waiting && allDone && !stopped) setChatOpen(false);
  }

  // The pass gate: a FINISHED pass covers the composer — the next message
  // is a new pass. Composing runs the chat full screen until the new pass
  // makes tasks; the parent owns that state.
  const passDone = !running && !waiting && allDone;
  const startNextPass = (): void => {
    props.onArmNewPass(true);
    setChatOpen(true);
  };
  const nextColor = passColor(passNum + 1);
  const collapsed = hasBoard && !chatOpen && !composing;
  const openChat = (): void => setChatOpen(true);

  const board = (
    <div
      ref={scrollRef}
      onPointerDown={() => (interactingUntil.current = Date.now() + 1500)}
      className="flex-1 overflow-y-auto select-text"
    >
      <div className="mx-auto w-full max-w-3xl px-6 py-5">
        {goal ? (
          <div className="mb-5">
            {/* With follow-up rounds the original request lives in its own
                collapsed row below. The plan pin stays: it is the thread's
                identity, not a round's. */}
            {session.planPath ? (
              <PlanPin session={session} planPath={session.planPath} running={running} onOpenFile={props.onOpenFile} />
            ) : curRound === 0 ? (
              <p className="text-sm leading-snug font-medium tracking-[-0.01em]">{firstLine(goal)}</p>
            ) : null}
            {curRound === 0 && todos.length > 0 ? <ProgressSegments todos={todos} /> : null}
            <ChangesLine session={session} onShow={props.onShowSourceControl} />
          </div>
        ) : null}

        {agents.length > 0 ? (
          <div className="mb-5">
            <p className="mb-1 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">Subagents</p>
            <div className="-mx-3 flex flex-col gap-0.5">
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  now={agentNow}
                  hidden={agent.id === openAgentId}
                  onOpen={() => setOpenAgentId(agent.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Previous passes tuck away: one row each (request · tasks ·
            diffstat), expanding in place. */}
        {curRound > 0 ? (
          <div className="mb-8 divide-y divide-content/10 border-y border-content/10">
            {rounds.slice(0, curRound).map((data, r) => (
              <RoundSection
                key={r}
                session={session}
                round={r}
                passNum={passNums[r]}
                data={data}
                isCurrent={false}
                multi
                expanded={openRounds.has(r)}
                onToggle={() => setOpenRounds((prev) => toggleIn(prev, r))}
                running={running}
                now={now}
                pastCosts={pastCosts}
                marks={usageMarks}
                diskOnly={diskOnly}
                openChange={openChange}
                setOpenChange={setOpenChange}
                toggled={toggledTasks}
                setToggled={setToggledTasks}
                stopped={stopped}
                onNeedsUser={openChat}
                onOpenFile={props.onOpenFile}
                onOpenDiff={props.onOpenDiff}
              />
            ))}
          </div>
        ) : null}
        <RoundSection
          key={curRound}
          session={session}
          round={curRound}
          passNum={passNums[curRound]}
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
          stopped={stopped}
          onNeedsUser={openChat}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
        />

        {running && cur.work.length === 0 ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-content/55">
            <Spinner className="size-3.5" />
            {cur.todos.length === 0 ? "Breaking the task down…" : "Working…"}
          </div>
        ) : null}

        {closing ? (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="mt-6 border-t border-content/10 pt-4"
          >
            <AgentMarkdown text={closing.text} cwd={session.cwd} onOpenFile={props.onOpenFile} />
          </motion.div>
        ) : null}

        {/* The pass is done and the chat usually folded — the next pass
            starts HERE, wearing its color. */}
        {passDone ? (
          <div className="mt-5">
            <button
              type="button"
              onClick={startNextPass}
              className="rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.96]"
              style={{ background: nextColor }}
            >
              Start pass {passNum + 1}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );

  const chat = (
    <>
      {hasBoard ? (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-content/10 pr-1.5 pl-4">
          <span className="text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
            Conversation
          </span>
          <button
            type="button"
            onClick={() => (composing ? props.onArmNewPass(false) : setChatOpen(false))}
            title={composing ? "Show the board" : "Hide conversation"}
            aria-label={composing ? "Show the board" : "Hide conversation"}
            className="flex size-6 items-center justify-center rounded-md text-content/55 transition-colors hover:bg-content/8 hover:text-content"
          >
            <ChevronRight className={`size-3.5 ${composing ? "rotate-180" : ""}`} strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {/* The composer stays open — typing keeps working in the CURRENT
          pass. The banner is the door to the next one. */}
      {props.renderChat({
        topSlot:
          passDone && !composing ? (
            <PassBanner passNum={passNum} color={nextColor} onNext={startNextPass} />
          ) : undefined,
      })}
    </>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SplitShell
        board={board}
        chat={chat}
        hasBoard={hasBoard && !composing}
        collapsed={collapsed}
        onOpenChat={openChat}
        status={session.status}
      />
      <AnimatePresence>
        {openAgentId ? (
          <AgentDetail
            key={openAgentId}
            agentId={openAgentId}
            parentCwd={session.cwd}
            onClose={() => setOpenAgentId(null)}
            onOpenSession={props.onOpenSession}
            onOpenFile={props.onOpenFile}
            onOpenDiff={props.onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function findLast<T>(list: T[], test: (v: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return list[i];
  return undefined;
}

function toggleIn<T>(prev: Set<T>, v: T): Set<T> {
  const next = new Set(prev);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

/** One request round: its todo list, its blocks, its work items, and the
 *  user message that opened it. */
type RoundData = {
  todos: TodoItem[];
  blocks: Block[];
  work: Block[];
  header: Block | null;
};

type WorkHandlers = {
  stopped: boolean;
  onNeedsUser: () => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
};

/** One round's board. The CURRENT round renders in full; PAST rounds tuck
 *  away into one collapsed row that expands in place. Task bodies default
 *  open on the current round and fold shut on past ones. */
function RoundSection({
  session,
  round,
  passNum,
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
  setToggled,
  ...handlers
}: WorkHandlers & {
  session: Session;
  round: number;
  /** display number — hidden Q&A rounds don't consume one */
  passNum: number;
  data: RoundData;
  isCurrent: boolean;
  /** the thread has follow-up rounds — headers and separators appear */
  multi: boolean;
  expanded: boolean;
  onToggle?: () => void;
  running: boolean;
  now: number;
  /** cumulative session cost at each round boundary (pass cost = diff) */
  pastCosts: (number | undefined)[];
  marks: UsageMark[];
  diskOnly: LiveEditState[];
  openChange: OpenChange | null;
  setOpenChange: (v: OpenChange | null) => void;
  toggled: Set<string>;
  setToggled: Dispatch<SetStateAction<Set<string>>>;
}) {
  const { todos, blocks, work } = data;
  const reduce = useReducedMotion();
  const workByTodo = useMemo(() => groupByTodo(work, todos.length), [work, todos.length]);
  const blocksByTodo = useMemo(() => groupByTodo(blocks, todos.length), [blocks, todos.length]);
  // Per-todo wall clock from this round's blocks only.
  const spans = useMemo(() => {
    const m = new Map<number, { first: number; last: number }>();
    for (const b of blocks) {
      if (b.ts === undefined) continue;
      const k = b.todo ?? -1;
      const s = m.get(k);
      if (!s) m.set(k, { first: b.ts, last: b.ts });
      else s.last = b.ts;
    }
    return m;
  }, [blocks]);
  const roundMarks = useMemo(() => marks.filter((m) => m.round === round), [marks, round]);
  const preWork = todos.length ? (workByTodo.get(-1) ?? []) : [];
  const flatWork = todos.length === 0 ? (workByTodo.get(-1) ?? []) : [];

  // Shell-made changes file under the task that was running when the edit
  // began: the last task started before it, kept only if the edit falls
  // inside that task's span (the live tail stays open-ended).
  const shellByTask = useMemo(() => {
    const m = new Map<number, LiveEditState[]>();
    const entries = [...spans.entries()]
      .filter(([i]) => i >= 0)
      .sort((a, b) => a[1].first - b[1].first);
    if (entries.length === 0) return m;
    for (const e of diskOnly) {
      let owner: number | null = null;
      for (const [i, s] of entries) {
        if (e.startedTs >= s.first - 1500) owner = i;
      }
      if (owner === null) continue;
      const s = spans.get(owner)!;
      const openEnded = isCurrent && running && owner === entries[entries.length - 1][0];
      if (openEnded || e.startedTs <= s.last + 3000) {
        const arr = m.get(owner);
        if (arr) arr.push(e);
        else m.set(owner, [e]);
      }
    }
    return m;
  }, [diskOnly, spans, isCurrent, running]);

  const done = todos.filter((t) => t.status === "completed").length;
  const stat = useMemo(() => changeStat(work), [work]);
  const headerText = firstLine(data.header);

  // A round with nothing on the board (a pure Q&A pass) has no row to earn.
  if (multi && !isCurrent && todos.length === 0 && work.length === 0) return null;

  const body = (
    <>
      {preWork.length > 0 ? (
        <div className="mb-4">
          {round === 0 ? (
            <p className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
              Setup
            </p>
          ) : null}
          <WorkItems blocks={preWork} cwd={session.cwd} {...handlers} />
        </div>
      ) : null}

      {todos.length > 0 ? (
        <div className="mb-5 flex flex-col">
          {todos.map((todo, i) => {
            const key = `${round}:${i}`;
            const span = spans.get(i);
            const live = isCurrent && running && todo.status === "in_progress";
            const taskBlocks = blocksByTodo.get(i) ?? [];
            const ms = todo.status === "pending" ? null : activeMs(taskBlocks, live ? now : undefined);
            const items = workByTodo.get(i) ?? [];
            const folded = todo.status === "completed" && !items.some(needsUser);
            const bodyOpen = toggled.has(key) ? !isCurrent : isCurrent;
            const shell = shellByTask.get(i);
            return (
              <div
                key={key}
                className={`mb-2 overflow-hidden rounded-lg transition-colors duration-150 ${
                  live ? "bg-accent/10 hover:bg-accent/15" : "bg-content/5 hover:bg-content/8"
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setToggled((prev) => toggleIn(prev, key))}
                  className="cursor-pointer px-2 pt-0.5"
                >
                  <TodoRow
                    content={todo.content}
                    status={todo.status}
                    live={live}
                    ms={ms !== null && ms > 1500 ? ms : null}
                  />
                </div>
                <TweenHeight open={bodyOpen} animate={!reduce}>
                  <div>
                    {live ? <TaskActivity blocks={taskBlocks} /> : null}
                    {items.length > 0 || (folded && shell) ? (
                      folded ? (
                        <TaskGrid
                          blocks={taskBlocks}
                          shell={shell}
                          cwd={session.cwd}
                          openPath={
                            openChange?.round === round && openChange.task === i ? openChange.path : null
                          }
                          onPick={(path) =>
                            setOpenChange(
                              openChange?.round === round && openChange.task === i && openChange.path === path
                                ? null
                                : { round, task: i, path },
                            )
                          }
                          onOpenFile={handlers.onOpenFile}
                          onOpenDiff={handlers.onOpenDiff}
                        />
                      ) : (
                        <div className="px-3 pt-1 pb-2">
                          <WorkItems blocks={items} cwd={session.cwd} {...handlers} />
                        </div>
                      )
                    ) : null}
                    {live && shell && shell.length > 0 ? (
                      <DiskCards
                        edits={shell}
                        cwd={session.cwd}
                        onOpenFile={handlers.onOpenFile}
                        onOpenDiff={handlers.onOpenDiff}
                      />
                    ) : null}
                    {live || todo.status === "completed" ? (
                      <TaskMeta
                        index={i}
                        blocks={taskBlocks}
                        marks={roundMarks}
                        span={span}
                        live={live}
                        now={now}
                      />
                    ) : null}
                  </div>
                </TweenHeight>
              </div>
            );
          })}
        </div>
      ) : null}

      {flatWork.length > 0 ? (
        <div className="mb-4">
          <WorkItems blocks={flatWork} cwd={session.cwd} {...handlers} />
        </div>
      ) : null}
    </>
  );

  // A previous pass: "Pass N" leading its request, with the run's record
  // underneath — when it finished, how long it took, what ran it and what
  // it cost — expanding in place to the full board.
  if (multi && !isCurrent) {
    const endTs = findLast(blocks, (b) => b.ts !== undefined)?.ts;
    const turn = data.header?.role === "user" ? data.header.turn : undefined;
    const cost = (() => {
      const end = pastCosts[round];
      if (end === undefined) return undefined;
      const prev = findLast(pastCosts.slice(0, round), (c) => c !== undefined);
      return end - (prev ?? 0);
    })();
    const meta: string[] = [];
    if (endTs !== undefined) meta.push(WHEN_FMT.format(endTs));
    const worked = activeMs(blocks);
    if (worked > 1000) meta.push(duration(worked));
    if (turn?.model) {
      meta.push(resolveModel(session.harness, turn.model).name);
      if (turn.reasoning) meta.push(turn.reasoning[0].toUpperCase() + turn.reasoning.slice(1));
      meta.push(turn.context1m ? "1M" : "200k");
    }
    if (cost !== undefined && cost > 0.005) meta.push(`$${cost.toFixed(2)}`);
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          className="group/round flex w-full items-start gap-2.5 py-2 text-left"
        >
          <ChevronRight
            className={`mt-[3px] size-3.5 shrink-0 text-content/35 transition-transform duration-200 ${
              expanded ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: passColor(passNum) }} />
              <span className="shrink-0 text-[13px] font-semibold tracking-[-0.01em] text-content/85">
                Pass {passNum}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content/55 transition-colors group-hover/round:text-content">
                {headerText}
              </span>
              {todos.length > 0 ? (
                <span className="shrink-0 text-[11px] tabular-nums text-content/40">
                  {done}/{todos.length} tasks
                </span>
              ) : null}
              <Stat adds={stat.adds} dels={stat.dels} className="text-[11px] font-semibold" />
            </span>
            {meta.length > 0 ? (
              <span className="mt-0.5 block truncate text-[11px] tabular-nums text-content/40">
                {meta.join(" · ")}
              </span>
            ) : null}
          </span>
        </button>
        <TweenHeight open={expanded} animate={!reduce}>
          <div className="pt-1 pb-2 pl-6">{body}</div>
        </TweenHeight>
      </div>
    );
  }

  // The current pass: full size, its request as the working headline.
  return (
    <div>
      {multi && headerText ? (
        <div className="mb-4">
          <p className="text-sm leading-snug font-medium tracking-[-0.01em]">
            <span
              className="mr-2 mb-[1px] inline-block size-2 rounded-full align-middle"
              style={{ background: passColor(passNum) }}
            />
            {headerText}
          </p>
          {todos.length > 0 ? <ProgressSegments todos={todos} /> : null}
        </div>
      ) : null}
      {body}
    </div>
  );
}

/** +adds −dels, each coloured, nothing when both are zero. */
function Stat({ adds, dels, className = "" }: { adds: number; dels: number; className?: string }) {
  if (adds <= 0 && dels <= 0) return null;
  return (
    <span className={`shrink-0 tabular-nums ${className}`}>
      {adds > 0 ? <span className="text-success">+{adds}</span> : null}{" "}
      {dels > 0 ? <span className="text-danger">−{dels}</span> : null}
    </span>
  );
}

/** The pass banner: a quiet tab sitting on the composer's top edge once a
 *  pass completes. The whole tab is one button; typing below instead keeps
 *  working in the CURRENT pass. */
function PassBanner({ passNum, color, onNext }: { passNum: number; color: string; onNext: () => void }) {
  return (
    <button
      type="button"
      onClick={onNext}
      className="mx-4 flex w-[calc(100%-2rem)] items-center justify-between rounded-t-lg border border-b-0 py-1 pr-2.5 pl-3 transition-[filter] hover:brightness-140 active:brightness-115"
      style={{ background: `${color}14`, borderColor: `${color}26` }}
    >
      <span className="flex items-center gap-2 text-[11px] text-content/55">
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        Pass {passNum} complete
      </span>
      <span className="text-[11px] font-medium" style={{ color }}>
        Start pass {passNum + 1}
      </span>
    </button>
  );
}

/** The work stream for one group, in birth order. Approvals and questions
 *  live in the transcript; here they are one line that opens the chat. */
function WorkItems({ blocks, cwd, stopped, onNeedsUser, onOpenFile }: WorkHandlers & { blocks: Block[]; cwd: string }) {
  const reduce = useReducedMotion();
  const lastError = findLast(blocks, isError);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b) =>
        needsUser(b) ? (
          <button
            key={b.id}
            type="button"
            onClick={onNeedsUser}
            className="flex h-[34px] items-center gap-2 rounded-lg border border-warning/20 bg-warning/5 px-2.5 text-left transition-colors hover:bg-warning/10"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-warning" />
            <span className="min-w-0 flex-1 truncate text-xs text-content/80">
              {b.question ? b.question.questions[0]?.question : b.tool?.title || b.text || "Approval"}
            </span>
            <span className="shrink-0 text-[11px] font-medium text-warning">needs you</span>
          </button>
        ) : isError(b) ? (
          <ErrorChip key={b.id} text={b.text} stopped={stopped && b === lastError} />
        ) : b.tool?.preview ? (
          <motion.div
            key={b.id}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <FilePreview preview={b.tool.preview} status="accepted" cwd={cwd} onOpenFile={onOpenFile} />
          </motion.div>
        ) : null,
      )}
    </div>
  );
}

/** A failed run, or the quiet gray note when the user hit Stop. */
function ErrorChip({ text, stopped }: { text: string; stopped: boolean }) {
  if (stopped) {
    return (
      <div className="flex h-[34px] items-center gap-2 rounded-lg border border-content/10 bg-content/5 px-2.5">
        <span className="size-1.5 shrink-0 rounded-full bg-content/40" />
        <span className="shrink-0 text-xs font-medium text-content/55">Stopped</span>
      </div>
    );
  }
  return (
    <div className="flex h-[34px] items-center gap-2 rounded-lg border border-danger/15 bg-danger/5 px-2.5">
      <span className="size-1.5 shrink-0 rounded-full bg-danger/80" />
      <span className="shrink-0 text-xs font-medium text-danger/80">Error</span>
      <span className="min-w-0 flex-1 truncate text-xs text-content/80">{text}</span>
    </div>
  );
}

/** One tick per todo — the progress reads as a shape, not a number. */
function ProgressSegments({ todos }: { todos: { status: TodoStatus }[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div
      className="mt-2.5 flex h-[3px] max-w-72 gap-[3px]"
      role="img"
      aria-label={`${done} of ${todos.length} tasks done`}
    >
      {todos.map((t, i) => (
        <span
          key={i}
          className={`min-w-0 flex-1 rounded-full transition-colors duration-300 ${
            t.status === "completed"
              ? "bg-success"
              : t.status === "in_progress"
                ? "animate-pulse bg-success/35"
                : "bg-content/15"
          }`}
        />
      ))}
    </div>
  );
}

/** The blast radius: working-tree diffstat, click-through to source control. */
function ChangesLine({ session, onShow }: { session: Session; onShow?: () => void }) {
  const [files, setFiles] = useState<CheckpointFile[]>([]);
  const idle = session.status === "idle";
  // Refresh when the turn settles — that's when edits have landed.
  useEffect(() => {
    let alive = true;
    const fetch = (): void => {
      sessionCheckpointStatus(session.id, session.cwd)
        .then((s) => alive && setFiles(s.files))
        .catch(() => {});
    };
    fetch();
    const off = subscribeGitChanged(fetch);
    return () => {
      alive = false;
      off();
    };
  }, [session.id, session.cwd, idle]);

  if (files.length === 0) return null;
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <button
      type="button"
      onClick={onShow}
      className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums text-content/55 transition-colors hover:text-content"
    >
      {files.length} {files.length === 1 ? "file" : "files"}
      <span className="text-success">+{adds}</span>
      <span className="text-danger">−{dels}</span>
    </button>
  );
}

/** Slim plan row: status glyph, title, wall clock. */
function TodoRow({
  content,
  status,
  live,
  ms,
}: {
  content: string;
  status: TodoStatus;
  /** in_progress AND the session is actually running — spinner-worthy */
  live: boolean;
  ms: number | null;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-2 py-[5px] ${
        live ? "text-content" : status === "completed" ? "text-content/55" : "text-content/40"
      }`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {live ? (
          <Spinner className="size-3.5" />
        ) : status === "completed" ? (
          <Check className="size-3.5 text-success" strokeWidth={2} />
        ) : (
          <Circle className="size-3 text-content/35" strokeWidth={1.75} />
        )}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
          status === "completed" ? "text-content/55" : ""
        }`}
      >
        {content}
      </span>
      {ms !== null ? (
        <span className="shrink-0 text-[11px] tabular-nums text-content/35">{duration(ms)}</span>
      ) : null}
    </div>
  );
}

/** Live activity summary for the working task — counts, not noise. */
function TaskActivity({ blocks }: { blocks: Block[] }) {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    if (b.role !== "tool") continue;
    const k = actKind(b);
    if (k === "edit") continue; // edits render as cards below
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = ACT_KINDS.flatMap(([, k, label]) => {
    const n = counts.get(k);
    return n ? [`${n} ${label}`] : [];
  });
  const other = counts.get("tool");
  if (other) parts.push(`${other} other tools`);
  if (parts.length === 0) return null;
  return <p className="px-4 pb-1 text-[11px] tabular-nums text-content/45">{parts.join(" · ")}</p>;
}

/** The diff a grid row or shell row opens: the preview card (capped at a
 *  few lines) with the door to the full diff under it. */
function ChangeCard({
  block,
  cwd,
  onOpenFile,
  onOpenDiff,
  onClose,
}: {
  block: Block;
  cwd: string;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onClose?: () => void;
}) {
  const preview = block.tool?.preview;
  if (!preview) return null;
  return (
    <div className="py-1">
      <FilePreview preview={preview} status="accepted" cwd={cwd} onOpenFile={onOpenFile} />
      <div className="mt-1 flex gap-3 px-1 text-[11px] text-content/45">
        <button type="button" onClick={() => onOpenDiff(preview.path)} className="transition-colors hover:text-content">
          Open diff
        </button>
        {onClose ? (
          <button type="button" onClick={onClose} className="transition-colors hover:text-content">
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A settled task's footprint: every touched file as a quiet text row —
 *  click one and its diff opens in place. Shell-made changes join the
 *  grid as rows marked `shell`. */
function TaskGrid({
  blocks,
  shell,
  cwd,
  openPath,
  onPick,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  shell?: LiveEditState[];
  cwd: string;
  openPath: string | null;
  onPick: (path: string) => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
}) {
  const gid = useId();
  const files = new Map<
    string,
    { name: string; adds: number; dels: number; ms: number; edits: Block[]; disk?: LiveEditState }
  >();
  for (const b of blocks) {
    const path = editPath(b);
    if (!path) continue;
    const cur = files.get(path) ?? {
      name: path.split("/").pop() ?? path,
      adds: 0,
      dels: 0,
      ms: 0,
      edits: [],
    };
    cur.adds += b.tool?.preview?.additions ?? 0;
    cur.dels += b.tool?.preview?.deletions ?? 0;
    cur.edits.push(b);
    if (b.doneTs !== undefined && b.ts !== undefined) cur.ms += b.doneTs - b.ts;
    files.set(path, cur);
  }
  for (const e of shell ?? []) {
    if (files.has(e.path)) continue;
    files.set(e.path, {
      name: e.path.split("/").pop() ?? e.path,
      adds: e.adds ?? 0,
      dels: e.dels ?? 0,
      ms: e.ts - e.startedTs,
      edits: [],
      disk: e,
    });
  }
  const open = openPath ? files.get(openPath) : null;
  if (files.size === 0) return null;
  // Locked layout: rows keep a stable layoutId (so the card can morph
  // from/to them) but layoutDependency pins them — motion only re-measures
  // when openPath changes, so unrelated reflows (a task collapsing above)
  // move them rigidly with the page instead of springing them around.
  // The clicked row leaves the grid while its card is open: siblings slide
  // over to fill the slot, the card morphs open from the row's snapshot
  // (shared layoutId), and on close it morphs back into the remounting row.
  // The height wrapper tweens so everything below slides instead of jumping.
  // The group id is this mount's, so the same file in another pane, task
  // or round never morphs across.
  return (
    <LayoutGroup id={gid}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-x-4 px-4 pb-2">
        {[...files.entries()].map(([path, f]) =>
          path === openPath ? null : (
            <motion.button
              key={path}
              type="button"
              layoutId={`chg-${path}`}
              layoutDependency={openPath}
              transition={SPRING_PANEL}
              onClick={() => onPick(path)}
              title={path}
              className="flex items-center gap-2 py-0.5 text-left text-[12px] transition-colors hover:text-content"
            >
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-content/35">
                {f.ms > 1500 ? `~${duration(f.ms)}` : ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-content/55">
                {f.name}
                {f.disk ? <span className="ml-1.5 text-[11px] text-content/35">shell</span> : null}
              </span>
              <Stat adds={f.adds} dels={f.dels} />
            </motion.button>
          ),
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && openPath ? (
          <motion.div
            key={openPath}
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden px-3"
          >
            <motion.div layoutId={`chg-${openPath}`} layoutDependency={openPath} transition={SPRING_PANEL}>
              <ChangeCard
                block={open.disk ? diskBlock(open.disk) : wholeChange(openPath, open.edits)}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                onClose={() => onPick(openPath)}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </LayoutGroup>
  );
}

const TICK_COLOR: Record<string, string> = {
  read: "bg-info/60",
  search: "bg-info/60",
  command: "bg-warning/60",
  subagent: "bg-violet/70",
  web: "bg-info/60",
  edit: "bg-success/80",
  tool: "bg-content/25",
};

/** What a tool call did — the payload beats the tool name. */
function tickDetail(b: Block): string {
  const name = b.tool?.name ?? b.tool?.title ?? "tool";
  const input = (b.tool?.input && typeof b.tool.input === "object" ? b.tool.input : {}) as Record<
    string,
    unknown
  >;
  const raw =
    [input.file_path, input.path, input.command, input.pattern, input.query, input.description].find(
      (v) => typeof v === "string" && v,
    ) ??
    b.tool?.preview?.path ??
    "";
  const payload = String(raw).split("/").slice(-2).join("/").slice(0, 60);
  return payload ? `${name} · ${payload}` : name;
}

/** Per-task telemetry: tokens (exact boundary deltas only), compactions,
 *  and the horizontal activity timeline. */
function TaskMeta({
  index,
  blocks,
  marks,
  span,
  live = false,
  now = 0,
}: {
  index: number;
  blocks: Block[];
  marks: UsageMark[];
  span?: { first: number; last: number };
  /** the task is the one working right now — its timeline runs on the clock */
  live?: boolean;
  now?: number;
}) {
  // Token delta = last mark inside this task minus last mark before it.
  const end = findLast(marks, (m) => m.todo === index);
  const base = findLast(marks, (m) => m.todo < index);
  const out =
    end?.output !== undefined && base?.output !== undefined && end.output >= base.output
      ? end.output - base.output
      : undefined;
  const compactions = blocks.filter(isCompaction).length;
  const [hover, setHover] = useState<number | null>(null);
  const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

  // A live task's timeline runs to NOW, not to its last event — the bar
  // keeps growing between events, and the 1s-linear transition on each
  // tick makes the marks glide left instead of stepping.
  const tlEnd = span ? (live ? Math.max(now, span.last) : span.last) : 0;
  const dur = span ? tlEnd - span.first : 0;
  const ticks =
    dur > 3000 && span
      ? blocks.flatMap((b) =>
          b.ts === undefined || b.role !== "tool"
            ? []
            : [
                {
                  at: (b.ts - span.first) / dur,
                  k: actKind(b),
                  detail: tickDetail(b),
                  off: b.ts - span.first,
                },
              ],
        )
      : [];
  const compactTicks =
    dur > 3000 && span
      ? blocks.flatMap((b) =>
          isCompaction(b) && b.ts !== undefined ? [{ at: (b.ts - span.first) / dur }] : [],
        )
      : [];

  if (out === undefined && compactions === 0 && ticks.length === 0) return null;
  const hovered = hover !== null ? ticks[hover] : undefined;
  return (
    <div className="px-4 pb-2">
      {out !== undefined || compactions > 0 ? (
        <p className="text-[11px] tabular-nums text-content/40">
          {out !== undefined ? `${fmtTok(out)} output tokens` : null}
          {out !== undefined && compactions > 0 ? " · " : null}
          {compactions > 0 ? (
            <span className="text-violet">
              {compactions} compaction{compactions > 1 ? "s" : ""}
            </span>
          ) : null}
        </p>
      ) : null}
      {ticks.length > 1 ? (
        <div
          className="relative"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            // Nearest mark to the cursor: the popup names what IT did.
            const rect = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            let best = -1;
            let bestD = 0.03; // within 3% of the bar, else nothing
            ticks.forEach((t, n) => {
              const d = Math.abs(t.at - x);
              if (d < bestD) {
                bestD = d;
                best = n;
              }
            });
            setHover(best >= 0 ? best : null);
          }}
        >
          <div className="relative mt-1 h-[5px] overflow-hidden rounded-full bg-content/5">
            {/* A full-width carrier slides on transform, so a moving mark
                never triggers layout. */}
            {ticks.map((t, n) => (
              <span
                key={n}
                className="absolute inset-0 transition-transform duration-1000 ease-linear"
                style={{ transform: `translateX(${Math.min(99, t.at * 100)}%)` }}
              >
                <span
                  className={`absolute top-0 left-0 h-full w-[3px] rounded-full ${
                    TICK_COLOR[t.k]
                  } ${hover === n ? "brightness-150" : ""}`}
                />
              </span>
            ))}
            {compactTicks.map((t, n) => (
              <span
                key={`c${n}`}
                className="absolute inset-0 transition-transform duration-1000 ease-linear"
                style={{ transform: `translateX(${Math.min(99, t.at * 100)}%)` }}
              >
                <span className="absolute top-0 left-0 h-full w-[2px] bg-violet" />
              </span>
            ))}
          </div>
          {/* The popup floats over the bar at the mark — nothing reflows. */}
          {hovered ? (
            <div
              className="pointer-events-none absolute bottom-full z-20 mb-1.5 -translate-x-1/2 rounded-lg border border-content/15 bg-background-base px-2.5 py-1 text-[11px] whitespace-nowrap shadow-[0_4px_16px_rgb(0_0_0/0.12)]"
              style={{ left: `${Math.min(92, Math.max(8, hovered.at * 100))}%` }}
            >
              <span className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${TICK_COLOR[hovered.k]}`} />
              {hovered.detail}
              <span className="ml-1.5 text-content/40 tabular-nums">{duration(hovered.off)} in</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Shell-made changes the harness never described: disk truth, labeled
 *  as such — never presented as a tool edit. Rows with a diff expand in
 *  place to show it. */
function DiskCards({
  edits,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  edits: LiveEditState[];
  cwd: string;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="flex flex-col gap-1 px-3 pb-2">
      {edits.slice(0, 20).map((e) => {
        const expandable = !!e.diff;
        const isOpen = open.has(e.path);
        return (
          <div key={e.path}>
            <button
              type="button"
              disabled={!expandable}
              onClick={() => setOpen((prev) => toggleIn(prev, e.path))}
              className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px]"
            >
              {e.state === "editing" ? <Spinner className="size-3" /> : null}
              <span className="min-w-0 truncate font-medium">{e.path.split("/").pop()}</span>
              <span className="truncate text-[11px] text-content/40">{e.path}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <span className="text-[11px] text-content/35">via shell</span>
                <Stat adds={e.adds ?? 0} dels={e.dels ?? 0} className="text-[11px] font-semibold" />
                {expandable ? (
                  <ChevronRight
                    className={`size-3 text-content/35 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
                    strokeWidth={1.75}
                  />
                ) : null}
              </span>
            </button>
            {expandable ? (
              <TweenHeight open={isOpen} animate={!reduce}>
                <ChangeCard block={diskBlock(e)} cwd={cwd} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
              </TweenHeight>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const PIN_CADENCE = { running: 4000, idle: 15000 };

/** Plan-started threads pin the PLAN, not the kickoff sentence: title,
 *  live tick count, click-through to the document. */
function PlanPin({
  session,
  planPath,
  running,
  onOpenFile,
}: {
  session: Session;
  planPath: string;
  running: boolean;
  onOpenFile: OpenFileFn;
}) {
  const doc = usePlanFile(planPath, running, PIN_CADENCE) ?? "";
  const title = planHeading(doc) ?? session.title;
  const { done, total } = planProgress(doc);
  return (
    <button
      type="button"
      onClick={() => onOpenFile(planPath)}
      title="Open the plan document"
      className="group flex w-full items-baseline gap-2 text-left"
    >
      <p className="min-w-0 truncate text-sm leading-snug font-medium tracking-[-0.01em] group-hover:underline">
        {title}
      </p>
      {total > 0 ? (
        <span className="shrink-0 text-[11px] tabular-nums text-content/55">
          {done}/{total} ticked
        </span>
      ) : null}
    </button>
  );
}
