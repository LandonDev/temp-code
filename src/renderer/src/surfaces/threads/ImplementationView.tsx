import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, FileText } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Spinner } from "../../components/ui/spinner";
import { StatusMark } from "../../components/ui/status";
import { TaskList } from "../../components/ui/task-list";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { usePlanFile } from "../../hooks/usePlanFile";
import { resolveModel } from "../../lib/models";
import type { Block, Session } from "../../lib/session";
import { useLiveEdits, type LiveEditState } from "../../lib/tcserver/store";
import { emptyThread } from "../../lib/tcserver/todos";
import { useMetaById } from "../../lib/threads/agents";
import { planHeading } from "../../lib/threads/planDoc";
import { actKind, changeStat, editPath } from "../../lib/threads/rounds";
import { AgentMarkdown } from "../AgentMarkdown";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { duration } from "../../lib/duration";
import { THREAD_GLYPHS } from "./threadTypes";
import { ChangeRows } from "./ChangeRows";
import { AgentDetail } from "./fleet/AgentDetail";
import {
  changesByTask,
  firstLine,
  foldRounds,
  isHiddenPass,
  lastFailure,
  needsYou,
  passCost,
  passNumbers,
  passRecord,
  tasksOf,
  type PassRecord,
  type RoundData,
} from "./implementationBoard";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Implementation thread: the TASKS and the CHANGES are the view. The board
 * is the pass's task list, a line for anything that needs the person or
 * failed, the files each task changed (each opening its diff in place),
 * and the agent's closing report; earlier passes fold into rows above.
 * Every other mechanic (thinking, reads, commands, prose) lives in the
 * chat beside it; live subagents and the tree's changes are the right
 * panel's.
 */

/** "Aug 16, 9:25 PM": a pass record's completion stamp, local time. */
const WHEN_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const PLAN_CADENCE = { running: 4000, idle: 15000 };

export function ImplementationView(props: ThreadViewProps) {
  const { session, composing } = props;
  const thread = session.thread ?? emptyThread();
  const { todos, rounds: pastTodos, costs, stopped } = thread;
  const blocks = session.blocks;
  const running = session.status === "running" || session.status === "starting";
  const waiting = session.status === "waiting";
  // The transcript's subagent rows open their detail over the view.
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const curRound = pastTodos.length;
  const rounds = useMemo(() => foldRounds(blocks, todos, pastTodos), [blocks, todos, pastTodos]);
  const cur = rounds[curRound];
  const passNums = useMemo(() => passNumbers(rounds), [rounds]);
  const passNum = passNums[curRound] || Math.max(0, ...passNums);

  const allDone = cur.todos.length > 0 && cur.todos.every((t) => t.status === "completed");
  // The agent's final report closes the board, and a follow-up that made
  // no task list shows its answer here too.
  const closing = useMemo(() => {
    const last = blocks[blocks.length - 1];
    return (allDone || (!running && cur.todos.length === 0)) &&
      last?.role === "assistant" &&
      !last.streaming &&
      last.text.trim()
      ? last
      : null;
  }, [blocks, allDone, running, cur.todos.length]);

  // Disk changes with no matching harness edit: shell-made work. A change
  // only counts as THIS thread's if it began inside one of the thread's
  // own tool windows: a shell command running, or a subagent working.
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
        windows.push({ from: b.ts - 1500, to: b.doneTs === undefined ? Number.MAX_SAFE_INTEGER : b.doneTs + 2500 });
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
  // A plain chat until a pass makes tasks; once any pass has, the thread
  // stays a board.
  const hasBoard = todos.length > 0 || pastTodos.some((t) => t.length > 0);
  // Returning to a finished thread lands on the board alone: the chat
  // starts folded. `loaded` is the store's bit, set once the backlog has
  // replayed, so a first mount before hydration never folds.
  const settled = !running && !waiting && allDone && !stopped;
  const loaded = session.loaded === true;
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
  // The chat follows the run: starting again reopens it, and the run
  // FINISHING with every task done folds it. A stop, a question, or an
  // unfinished list keeps it open: the person still has to talk.
  const [sawRunning, setSawRunning] = useState(running);
  if (running !== sawRunning) {
    setSawRunning(running);
    if (running) setChatOpen(true);
    else if (!waiting && allDone && !stopped) setChatOpen(false);
  }

  // A finished pass: the next message is a new pass, armed from the board.
  const passDone = !running && !waiting && allDone;
  const startNextPass = (): void => {
    props.onArmNewPass(true);
    setChatOpen(true);
  };
  const collapsed = hasBoard && !chatOpen && !composing;
  const openChat = (): void => setChatOpen(true);
  // Folding the chat while a new pass is armed puts the pass back.
  const toggleChat = (open: boolean): void => {
    if (!open && composing) props.onArmNewPass(false);
    setChatOpen(open);
  };

  const planDoc = usePlanFile(session.planPath ?? null, running, PLAN_CADENCE) ?? "";
  const title = (session.planPath ? planHeading(planDoc) : null) ?? (firstLine(goal) || session.title);
  // The planning thread the plan came from: the server's link, so the
  // build points back even once the plan is archived.
  const plan = useMetaById(session.planThreadId ?? null);
  const PlanGlyph = THREAD_GLYPHS.planning;
  const planPath = session.planPath;
  const actions = (
    <>
      {planPath ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Open the plan" onClick={() => props.onOpenFile(planPath)} />
            }
          >
            <FileText />
          </TooltipTrigger>
          <TooltipContent>Open the plan</TooltipContent>
        </Tooltip>
      ) : null}
      {plan && props.onOpenSession ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open the planning thread"
                onClick={() => props.onOpenSession?.(plan.id)}
              />
            }
          >
            <PlanGlyph />
          </TooltipTrigger>
          <TooltipContent>
            Planned in {plan.title}
            {plan.archived ? " (archived)" : ""}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );

  const asking = needsYou(cur.work);
  const failure = running ? undefined : lastFailure(cur.work);
  const changes = useMemo(() => changesByTask(cur, diskOnly, true, running), [cur, diskOnly, running]);
  const pastPasses = rounds.slice(0, curRound);

  const board = (
    <div
      ref={scrollRef}
      onPointerDown={() => (interactingUntil.current = Date.now() + 1500)}
      className="flex-1 overflow-y-auto select-text"
    >
      <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
        {pastPasses.some((r) => !isHiddenPass(r)) ? (
          <div className="-mx-2 mb-6 flex flex-col gap-1">
            {pastPasses.map((r, i) =>
              isHiddenPass(r) ? null : (
                <PastPass
                  key={i}
                  session={session}
                  round={i}
                  passNum={passNums[i]}
                  data={r}
                  record={passRecord(r, passCost(costs, i))}
                  diskOnly={diskOnly}
                  onOpenFile={props.onOpenFile}
                  onOpenDiff={props.onOpenDiff}
                />
              ),
            )}
          </div>
        ) : null}

        {curRound > 0 && cur.header ? (
          <p className="mb-2 text-sm font-medium text-foreground">{firstLine(cur.header)}</p>
        ) : null}
        {cur.todos.length > 0 ? (
          <TaskList key={curRound} title="Tasks" tasks={tasksOf(cur.todos, curRound, running)} />
        ) : running && cur.work.length === 0 ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner />
            Breaking the task down…
          </p>
        ) : null}

        {asking.length > 0 || failure ? (
          <div className="-mx-2 mt-2 flex flex-col gap-0.5">
            {asking.map((b) => (
              <Button key={b.id} variant="ghost" onClick={openChat} className="h-7 w-full justify-start px-2 font-normal">
                <StatusMark state="waiting" detail={askLine(b)} />
              </Button>
            ))}
            {failure ? (
              <div className="flex h-7 items-center px-2">
                {failure.stopped || stopped ? (
                  <StatusMark state="stopped" />
                ) : (
                  <StatusMark state="failed" detail={failure.failure?.summary ?? failure.text} />
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {changes.length > 0 ? (
          <section aria-label="Changes" className="mt-6">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Changes</h3>
            <ChangeRows groups={changes} cwd={session.cwd} onOpenFile={props.onOpenFile} onOpenDiff={props.onOpenDiff} />
          </section>
        ) : null}

        {closing ? (
          <AgentMarkdown
            className="mt-6 text-[15px] leading-[1.6]"
            text={closing.text}
            cwd={session.cwd}
            onOpenFile={props.onOpenFile}
          />
        ) : null}

        {passDone && !composing ? (
          <Button variant="secondary" size="sm" className="mt-4" onClick={startNextPass}>
            Start pass {passNum + 1}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <OpenAgentDetailContext.Provider value={setOpenAgentId}>
        <SplitShell
          board={board}
          chat={props.renderChat()}
          hasBoard={hasBoard}
          collapsed={collapsed}
          onToggleChat={toggleChat}
          title={title}
          actions={actions}
        />
      </OpenAgentDetailContext.Provider>
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

/** What a waiting approval or question is about, in one line. */
function askLine(b: Block): string {
  return b.question ? (b.question.questions[0]?.question ?? "") : b.tool?.title || b.text || "Approval";
}

/** A finished pass's record as words, each its own fact. */
function recordFacts(rec: PassRecord, harness: Session["harness"]): string[] {
  const facts: string[] = [];
  if (rec.endedAt !== undefined) facts.push(WHEN_FMT.format(rec.endedAt));
  if (rec.workedMs !== undefined) facts.push(duration(rec.workedMs));
  if (rec.model) facts.push(resolveModel(harness, rec.model).name);
  if (rec.effort) facts.push(rec.effort);
  if (rec.context) facts.push(rec.context);
  if (rec.speed) facts.push(rec.speed);
  if (rec.cost !== undefined) facts.push(`$${rec.cost.toFixed(2)}`);
  return facts;
}

/** An earlier pass: one row (its number, its request, the tally and the
 *  diffstat over the run's record) opening its tasks and changes. */
function PastPass({
  session,
  round,
  passNum,
  data,
  record,
  diskOnly,
  onOpenFile,
  onOpenDiff,
}: {
  session: Session;
  round: number;
  passNum: number;
  data: RoundData;
  record: PassRecord;
  /** Shell-made changes; each files under the task that ran when it began. */
  diskOnly: LiveEditState[];
  onOpenFile: ThreadViewProps["onOpenFile"];
  onOpenDiff: (path?: string) => void;
}) {
  const done = data.todos.filter((t) => t.status === "completed").length;
  const stat = changeStat(data.work);
  const facts = recordFacts(record, session.harness);
  const groups = useMemo(() => changesByTask(data, diskOnly, false, false), [data, diskOnly]);
  return (
    <Collapsible data-pass={passNum}>
      <CollapsibleTrigger className="group/pass flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
        <span className="flex w-full items-center gap-2">
          <span className="shrink-0 text-[13px] font-medium text-foreground">Pass {passNum}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{firstLine(data.header)}</span>
          <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
            {data.todos.length > 0 ? (
              <span className="text-muted-foreground">
                {done}/{data.todos.length}
              </span>
            ) : null}
            {stat.adds > 0 ? <span className="text-success">+{stat.adds}</span> : null}
            {stat.dels > 0 ? <span className="text-destructive">−{stat.dels}</span> : null}
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform duration-(--dur-fast) ease-(--ease-out) group-data-[panel-open]/pass:rotate-90 motion-reduce:transition-none" />
          </span>
        </span>
        {facts.length > 0 ? (
          <span className="block truncate text-xs text-muted-foreground tabular-nums">
            {facts.map((f, i) => (
              <span key={i} className={i ? "ml-2" : undefined}>
                {f}
              </span>
            ))}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 px-2 pt-2 pb-3">
          {data.todos.length > 0 ? (
            <TaskList title="Tasks" defaultOpen={false} tasks={tasksOf(data.todos, round, false)} />
          ) : null}
          {groups.length > 0 ? (
            <ChangeRows groups={groups} cwd={session.cwd} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
