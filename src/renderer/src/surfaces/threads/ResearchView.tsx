import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OpenFileFn } from "../../lib/search";
import { ENTER } from "../../lib/ease";
import { ChevronRight, Search } from "../../chrome/icons";
import { usePlanFile } from "../../hooks/usePlanFile";
import type { Block, Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionStatus } from "../../lib/tcserver/types";
import { parseReport, type Report } from "../../lib/threads/planDoc";
import {
  EMPTY_BOARD,
  foldResearchBoard,
  hostOf,
  mergeAngles,
  type Angle,
  type SourceRow,
} from "../../lib/threads/researchBoard";
import { AgentMarkdown } from "../AgentMarkdown";
import { MatrixSpinner, PaneHeader } from "./bits";
import { AgentDetail } from "./fleet/AgentDetail";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { FleetPulseLine } from "./fleet/FleetPanel";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Research thread: the SOURCES are the view. It opens as a normal chat;
 * the moment research activity lands (a source boarded, the report file
 * born) a live board slides in on the left — report pin on top, then one
 * group per research angle with its queries and the sources they surfaced
 * streaming in beneath. The chat docks right, stays mounted when folded,
 * and folds itself once the report is complete.
 */

const NO_BLOCKS: Block[] = [];
const NO_AGENTS: string[] = [];
const subscribeMeta = (listener: () => void): (() => void) =>
  sessionStore.onMetaChange(listener);

/** A child that has settled: not running, starting or waiting. */
const settled = (status: SessionStatus | undefined): boolean =>
  status !== "running" && status !== "starting" && status !== "waiting";

/** How many of the spawned angles have settled (a primitive, for useSyncExternalStore). */
function useSettledCount(agents: string[]): number {
  return useSyncExternalStore(subscribeMeta, () =>
    agents.reduce((n, id) => n + (settled(sessionStore.metaOf(id)?.status) ? 1 : 0), 0),
  );
}

/** A child angle's live state: its blocks (empty when never opened) and
 *  meta. Primitives and stable references only, for useSyncExternalStore. */
function useAngleAgent(agentId: string): {
  blocks: Block[];
  status: SessionStatus | undefined;
  title: string | undefined;
} {
  const blocks = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.get(agentId)?.blocks ?? NO_BLOCKS,
  );
  const status = useSyncExternalStore(subscribeMeta, () => sessionStore.metaOf(agentId)?.status);
  const title = useSyncExternalStore(subscribeMeta, () => sessionStore.metaOf(agentId)?.title);
  return { blocks, status, title };
}

// ── favicon with a letter-tile fallback ────────────────────────────────

export function Favicon({ url }: { url: string }) {
  const host = hostOf(url);
  const [failed, setFailed] = useState(false);
  if (!host || failed) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-md bg-content/8 text-[11px] leading-none font-semibold text-content/50 uppercase">
        {host[0] ?? "?"}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      onError={() => setFailed(true)}
      alt=""
      className="size-4 shrink-0 rounded-md"
    />
  );
}

// ── the view ───────────────────────────────────────────────────────────

export function ResearchView(props: ThreadViewProps) {
  const { session, renderChat, onOpenFile } = props;
  const status = session.status;
  const running = status === "running" || status === "starting";
  const waiting = status === "waiting";
  const stopped = session.thread?.stopped ?? false;

  const sources = session.thread?.sources;
  const board = useMemo(
    () => (sources ? foldResearchBoard(sources) : EMPTY_BOARD),
    [sources],
  );
  // Angles: every spawned child, boarded or not, plus the root's own research.
  const agents = session.thread?.agents ?? NO_AGENTS;
  const angles = useMemo(() => mergeAngles(board, agents), [board, agents]);
  const done = useSettledCount(agents);
  const liveAngles = agents.length - done;

  // The report file, polled like the plan document.
  const doc = usePlanFile(session.planPath, running) ?? "";
  const report = useMemo(() => parseReport(doc), [doc]);
  const complete = report.status === "complete";
  const hasDoc = doc.trim().length > 0;
  const hasBoard = angles.length > 0 || hasDoc;

  // Chat pane phases (render-time adjusts): a question forces it open, a
  // run starting reopens it, and the run that COMPLETES the report folds
  // it — that run's deliverable is the report. Later runs are answer-first
  // follow-ups whose deliverable is the chat answer, so they stay open.
  const [chatOpen, setChatOpen] = useState(true);
  const completeAtRunStart = useRef(complete);
  const [sawWaiting, setSawWaiting] = useState(waiting);
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting);
    if (waiting) setChatOpen(true);
  }
  const [sawRunning, setSawRunning] = useState(running);
  if (running !== sawRunning) {
    setSawRunning(running);
    if (running) {
      completeAtRunStart.current = complete;
      setChatOpen(true);
    } else if (!waiting && complete && !completeAtRunStart.current && !stopped) {
      setChatOpen(false);
    }
  }
  const collapsed = hasBoard && !chatOpen;

  // A boarded angle group opens the agent's detail in place.
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const counts =
    board.sources > 0 || board.searches > 0
      ? `${board.sources} source${board.sources === 1 ? "" : "s"} · ${board.searches} search${
          board.searches === 1 ? "" : "es"
        }`
      : null;
  // Coverage counts spawned angles only, never the root's own group.
  const detail = agents.length
    ? [`${done} of ${agents.length} angle${agents.length === 1 ? "" : "s"} done`, counts]
        .filter(Boolean)
        .join(" · ")
    : counts;

  const boardPane = (
    <>
      <PaneHeader label="Research" detail={detail} />
      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        <div className="mx-auto w-full max-w-3xl px-6 py-5">
          {hasDoc ? (
            <ReportPane
              session={session}
              report={report}
              running={running}
              liveAngles={liveAngles}
              onOpenFile={onOpenFile}
            />
          ) : null}
          {angles.length > 0 ? (
            <div className={hasDoc ? "mt-6 border-t border-content/10 pt-5" : undefined}>
              {angles.map((angle) => (
                <AngleGroup
                  key={angle.agentId}
                  angle={angle}
                  self={angle.agentId === session.id}
                  onOpen={() => setOpenAgentId(angle.agentId)}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );

  const chatPane = (
    <>
      {hasBoard ? (
        <PaneHeader label="Conversation">
          <button
            type="button"
            onClick={() => setChatOpen(false)}
            title="Hide conversation"
            aria-label="Hide conversation"
            className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </PaneHeader>
      ) : null}
      {renderChat({ topSlot: <FleetPulseLine sessionId={session.id} /> })}
    </>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <OpenAgentDetailContext.Provider value={setOpenAgentId}>
      <SplitShell
        board={boardPane}
        chat={chatPane}
        hasBoard={hasBoard}
        collapsed={collapsed}
        onOpenChat={() => setChatOpen(true)}
        status={status}
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
            onOpenFile={onOpenFile}
            onOpenDiff={props.onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The report: a pin (title + state) while it is being researched and
 *  written, the full document rendered inline once complete. */
function ReportPane({
  session,
  report,
  running,
  liveAngles,
  onOpenFile,
}: {
  session: Session;
  report: Report;
  running: boolean;
  /** spawned angles still working — a "complete" report with any is early */
  liveAngles: number;
  onOpenFile: OpenFileFn;
}) {
  const complete = report.status === "complete";
  const reduce = useReducedMotion();
  const onOpen = (): void => {
    if (session.planPath) onOpenFile(session.planPath);
  };
  return (
    <motion.div
      initial={reduce ? false : ENTER.initial}
      animate={ENTER.animate}
      transition={ENTER.transition}
    >
      <button
        type="button"
        onClick={onOpen}
        title="Open the report file"
        className="group flex w-full items-baseline gap-2 px-2 text-left"
      >
        <p className="min-w-0 truncate text-sm leading-snug font-medium tracking-[-0.01em] group-hover:underline">
          {report.title ?? session.title}
        </p>
        {!complete ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-content/50">
            {running ? <MatrixSpinner cell={2} /> : null}
            in progress
          </span>
        ) : liveAngles > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-content/50">
            <MatrixSpinner cell={2} />
            complete · {liveAngles} angle{liveAngles === 1 ? "" : "s"} still running
          </span>
        ) : null}
      </button>
      {complete ? (
        <div className="mt-2 px-2 text-[13px]">
          <AgentMarkdown
            text={report.body}
            streaming={false}
            cwd={session.cwd}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : report.summary ? (
        <p className="mt-1 px-2 text-xs leading-snug text-content/50">{report.summary}</p>
      ) : null}
    </motion.div>
  );
}

/** What an angle's agent is doing right now, from its latest activity. */
function angleStatus(blocks: Block[]): string {
  const last = blocks[blocks.length - 1];
  if (last && (last.role === "assistant" || last.role === "reasoning")) return "synthesizing";
  let tool: Block | undefined;
  for (let i = blocks.length - 1; i >= 0 && !tool; i--) {
    if (blocks[i].role === "tool") tool = blocks[i];
  }
  const name = tool?.tool?.name ?? tool?.tool?.title ?? "";
  if (/fetch/i.test(name)) return "reading";
  if (/search/i.test(name) || tool?.tool?.preview?.kind === "search" || !tool) return "searching";
  return "reading";
}

/** One research angle: the agent's label, a live status line while it
 *  works, its findings file's state beneath, and its queries with sources
 *  streaming in under that. */
function AngleGroup({
  angle,
  self,
  onOpen,
  onOpenFile,
}: {
  angle: Angle;
  self: boolean;
  onOpen: () => void;
  onOpenFile: OpenFileFn;
}) {
  const agent = useAngleAgent(angle.agentId);
  const live = agent.status === "running" || agent.status === "starting";
  const label = self ? "Direct research" : (agent.title ?? angle.label);
  // The child's findings file (its planPath), polled like the report.
  const filePath = useSyncExternalStore(subscribeMeta, () =>
    self ? null : (sessionStore.metaOf(angle.agentId)?.planPath ?? null),
  );
  const fileDoc = usePlanFile(filePath, live);
  const findings = useMemo(() => (fileDoc ? parseReport(fileDoc) : null), [fileDoc]);
  return (
    <div className="mb-5 last:mb-0">
      <button
        type="button"
        onClick={onOpen}
        disabled={self}
        className={`group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${
          self ? "" : "transition-colors hover:bg-content/5 active:bg-content/10"
        }`}
      >
        <span className="min-w-0 truncate text-[12px] font-medium">{label}</span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-content/50">
            <MatrixSpinner cell={2} />
            {angleStatus(agent.blocks)}…
          </span>
        ) : null}
        {!self ? (
          <ChevronRight
            className="ml-auto size-3.5 shrink-0 text-content/40 opacity-0 transition-opacity group-hover:opacity-100"
            strokeWidth={1.75}
          />
        ) : null}
      </button>
      {findings && filePath ? (
        <button
          type="button"
          onClick={() => onOpenFile(filePath)}
          title="Open the findings file"
          className="flex w-full items-baseline gap-2 rounded-md px-2 py-0.5 text-left text-xs transition-colors hover:bg-content/5"
        >
          <span className="shrink-0 text-content/50">
            {findings.status === "complete" ? "done" : "in progress"}
          </span>
          {findings.summary ? (
            <span className="min-w-0 truncate text-content/70">{findings.summary}</span>
          ) : null}
        </button>
      ) : null}
      {angle.queries.map((q, i) => (
        <div key={i}>
          {q.query ? (
            <div className="mt-1.5 flex items-center gap-1.5 px-2 text-xs text-content/50">
              <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{q.query}</span>
            </div>
          ) : null}
          {q.sources.map((src) => (
            <SourceLink key={src.url} src={src} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One consulted source: favicon, name, and the address small at right. */
function SourceLink({ src }: { src: SourceRow }) {
  return (
    <button
      type="button"
      onClick={() => window.open(src.url, "_blank")}
      title={src.url}
      className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left transition-colors hover:bg-content/5 active:bg-content/10"
    >
      <Favicon url={src.url} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{src.title ?? hostOf(src.url)}</span>
      <span className="max-w-[45%] shrink-0 truncate text-xs text-content/40">
        {src.title ? src.url.replace(/^https?:\/\/(www\.)?/, "") : ""}
      </span>
    </button>
  );
}
