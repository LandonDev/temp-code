import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OpenFileFn } from "../../lib/search";
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
  type Angle,
  type SourceRow,
} from "../../lib/threads/researchBoard";
import { AgentMarkdown } from "../AgentMarkdown";
import { PaneHeader, Spinner } from "./bits";
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
const subscribeMeta = (listener: () => void): (() => void) =>
  sessionStore.onMetaChange(listener);

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
      <span className="flex size-4 shrink-0 items-center justify-center rounded bg-content/8 text-[9px] font-semibold text-content/55 uppercase">
        {host[0] ?? "?"}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      onError={() => setFailed(true)}
      alt=""
      className="size-4 shrink-0 rounded"
    />
  );
}

// ── the view ───────────────────────────────────────────────────────────

export function ResearchView(props: ThreadViewProps) {
  const { session, renderChat, onOpenFile, onOpenSession } = props;
  const status = session.status;
  const running = status === "running" || status === "starting";
  const waiting = status === "waiting";
  const stopped = session.thread?.stopped ?? false;

  const sources = session.thread?.sources;
  const board = useMemo(
    () => (sources ? foldResearchBoard(sources) : EMPTY_BOARD),
    [sources],
  );

  // The report file, polled like the plan document.
  const doc = usePlanFile(session.planPath, running) ?? "";
  const report = useMemo(() => parseReport(doc), [doc]);
  const complete = report.status === "complete";
  const hasDoc = doc.trim().length > 0;
  const hasBoard = board.angles.length > 0 || hasDoc;

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

  const detail =
    board.sources > 0 || board.searches > 0
      ? `${board.sources} source${board.sources === 1 ? "" : "s"} · ${board.searches} search${
          board.searches === 1 ? "" : "es"
        }`
      : null;

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
              onOpenFile={onOpenFile}
            />
          ) : null}
          {board.angles.length > 0 ? (
            <div className={hasDoc ? "mt-6 border-t border-content/10 pt-5" : undefined}>
              {board.angles.map((angle) => (
                <AngleGroup
                  key={angle.agentId}
                  angle={angle}
                  self={angle.agentId === session.id}
                  onOpen={() => onOpenSession?.(angle.agentId)}
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
            className="flex size-6 items-center justify-center rounded-md text-content/55 transition-colors hover:bg-content/5 hover:text-content"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </PaneHeader>
      ) : null}
      {renderChat({ topSlot: <FleetPulseLine sessionId={session.id} /> })}
    </>
  );

  return (
    <SplitShell
      board={boardPane}
      chat={chatPane}
      hasBoard={hasBoard}
      collapsed={collapsed}
      onOpenChat={() => setChatOpen(true)}
      status={status}
    />
  );
}

/** The report: a pin (title + state) while it is being researched and
 *  written, the full document rendered inline once complete. */
function ReportPane({
  session,
  report,
  running,
  onOpenFile,
}: {
  session: Session;
  report: Report;
  running: boolean;
  onOpenFile: OpenFileFn;
}) {
  const complete = report.status === "complete";
  const onOpen = (): void => {
    if (session.planPath) onOpenFile(session.planPath);
  };
  return (
    <div className="z-rise-in">
      <button
        type="button"
        onClick={onOpen}
        title="Open the report file"
        className="group flex w-full items-baseline gap-2 text-left"
      >
        <p className="min-w-0 truncate text-sm leading-snug font-medium tracking-[-0.01em] group-hover:underline">
          {report.title ?? session.title}
        </p>
        {!complete ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-content/55">
            {running ? <Spinner className="size-3" /> : null}
            in progress
          </span>
        ) : null}
      </button>
      {complete ? (
        <div className="mt-2 text-[13px]">
          <AgentMarkdown
            text={report.body}
            streaming={false}
            cwd={session.cwd}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : report.summary ? (
        <p className="mt-1 text-[12px] leading-snug text-content/55">{report.summary}</p>
      ) : null}
    </div>
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
 *  works, and its queries with sources streaming in beneath. */
function AngleGroup({
  angle,
  self,
  onOpen,
}: {
  angle: Angle;
  self: boolean;
  onOpen: () => void;
}) {
  const agent = useAngleAgent(angle.agentId);
  const live = agent.status === "running" || agent.status === "starting";
  const label = self ? "Direct research" : (agent.title ?? angle.label);
  return (
    <div className="mb-5 last:mb-0">
      <button
        type="button"
        onClick={onOpen}
        disabled={self}
        className={`group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${
          self ? "" : "transition-colors hover:bg-content/5"
        }`}
      >
        <span className="min-w-0 truncate text-[12px] font-medium">{label}</span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-content/55">
            <Spinner className="size-3" />
            {angleStatus(agent.blocks)}…
          </span>
        ) : null}
        {!self ? (
          <ChevronRight
            className="ml-auto size-3 shrink-0 text-content/35 opacity-0 transition-opacity group-hover:opacity-100"
            strokeWidth={1.75}
          />
        ) : null}
      </button>
      {angle.queries.map((q, i) => (
        <div key={i}>
          {q.query ? (
            <div className="mt-1.5 flex items-center gap-1.5 px-2 text-[11px] text-content/55">
              <Search className="size-3 shrink-0" strokeWidth={1.75} />
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
      className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left transition-colors hover:bg-content/5"
    >
      <Favicon url={src.url} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{src.title ?? hostOf(src.url)}</span>
      <span className="max-w-[45%] shrink-0 truncate text-[11px] text-content/40">
        {src.title ? src.url.replace(/^https?:\/\/(www\.)?/, "") : ""}
      </span>
    </button>
  );
}
