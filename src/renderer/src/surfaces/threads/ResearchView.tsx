import { AnimatePresence } from "motion/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OpenFileFn } from "../../lib/search";
import { FileText, Search } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Item, ItemButton, ItemContent, ItemTitle } from "../../components/ui/item";
import { StatusMark, threadStateOf } from "../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
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
import { AgentDetail } from "./fleet/AgentDetail";
import { OpenAgentDetailContext } from "../agentDetailContext";
import { SplitShell } from "./SplitShell";
import type { ThreadViewProps } from "./ThreadView";
import { useChatFold } from "../../lib/chatFold";

/**
 * Research thread: the SOURCES are the view. It opens as a normal chat;
 * the moment research activity lands (a source boarded, the report file
 * born) the board takes the left: the report on top, then one group per
 * research angle with its queries and the sources they surfaced streaming
 * in beneath. The chat sits right, stays mounted when folded, and folds
 * itself once the report is complete.
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
      <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[11px] leading-none font-semibold text-muted-foreground uppercase">
        {host[0] ?? "?"}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      onError={() => setFailed(true)}
      alt=""
      className="size-4 shrink-0 rounded-sm outline-1 -outline-offset-1 outline-image-outline"
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
  const [chatOpen, setChatOpen] = useChatFold(session.id, true, waiting);
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

  // Coverage counts spawned angles only, never the root's own group.
  const facts = [
    agents.length ? `${done} of ${agents.length} angle${agents.length === 1 ? "" : "s"}` : null,
    board.sources > 0 || board.searches > 0 ? `${board.sources} source${board.sources === 1 ? "" : "s"}` : null,
    board.sources > 0 || board.searches > 0 ? `${board.searches} search${board.searches === 1 ? "" : "es"}` : null,
  ].filter((f): f is string => f !== null);
  const detail = facts.length ? (
    <>
      {facts.map((f, i) => (
        <span key={i} className={i ? "ml-2" : undefined}>
          {f}
        </span>
      ))}
    </>
  ) : null;
  const reportPath = hasDoc ? session.planPath : null;
  const actions = reportPath ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Open the report" onClick={() => onOpenFile(reportPath)} />
        }
      >
        <FileText />
      </TooltipTrigger>
      <TooltipContent>Open the report</TooltipContent>
    </Tooltip>
  ) : null;

  const boardPane = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
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
            <section aria-label="Angles" className={hasDoc ? "mt-6" : undefined}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Angles</h3>
              <div className="-mx-2 flex flex-col gap-4">
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
            </section>
          ) : null}
        </div>
      </div>
    </>
  );

  const chatPane = renderChat();

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <OpenAgentDetailContext.Provider value={setOpenAgentId}>
      <SplitShell
        board={boardPane}
        chat={chatPane}
        hasBoard={hasBoard}
        collapsed={collapsed}
        onToggleChat={setChatOpen}
        title="Research"
        detail={detail}
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
            onOpenFile={onOpenFile}
            onOpenDiff={props.onOpenDiff}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The report: its title and state while it is being researched and
 *  written, the whole document once complete. */
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
  const state = running ? "working" : threadStateOf(session.status);
  return (
    <div>
      <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{report.title ?? session.title}</h2>
      {!complete ? (
        <>
          {state !== "idle" && state !== "done" ? (
            <StatusMark className="mt-2" state={state} detail={state === "working" ? "writing" : undefined} />
          ) : null}
          {report.summary ? <p className="mt-2 text-[13px] text-muted-foreground">{report.summary}</p> : null}
        </>
      ) : (
        <>
          {liveAngles > 0 ? (
            <StatusMark
              className="mt-2"
              state="working"
              detail={`${liveAngles} angle${liveAngles === 1 ? "" : "s"} still running`}
            />
          ) : null}
          <AgentMarkdown
            className="mt-4 text-[15px] leading-[1.6]"
            text={report.body}
            streaming={false}
            cwd={session.cwd}
            onOpenFile={onOpenFile}
          />
        </>
      )}
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

/** One research angle: the agent's label with its state while it works,
 *  its findings beneath, and its queries with the sources streaming in. */
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
  const head = (
    <>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      {live ? <StatusMark state="working" detail={angleStatus(agent.blocks)} /> : null}
    </>
  );
  return (
    <div data-angle>
      {self ? (
        <Item size="xs">{head}</Item>
      ) : (
        <ItemButton size="xs" onClick={onOpen} className="text-left hover:bg-muted">
          {head}
        </ItemButton>
      )}
      {findings?.summary && filePath ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onOpenFile(filePath)}
                className="h-auto w-full justify-start py-0.5 text-left font-normal whitespace-normal text-muted-foreground"
              />
            }
          >
            <span className="line-clamp-2">{findings.summary}</span>
          </TooltipTrigger>
          <TooltipContent>Open the findings</TooltipContent>
        </Tooltip>
      ) : null}
      {angle.queries.map((q, i) => (
        <div key={i}>
          {q.query ? (
            <div className="mt-1 flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Search className="size-3 shrink-0" />
              <span className="truncate">{q.query}</span>
            </div>
          ) : null}
          {q.sources.map((src) => (
            <SourceLink key={src.callId} src={src} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One consulted source: favicon, name, the host at the row's end, and
 *  beneath them the claim it supports when the agent cited one. */
function SourceLink({ src }: { src: SourceRow }) {
  const host = hostOf(src.url);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            onClick={() => window.open(src.url, "_blank")}
            className="h-auto min-h-7 w-full flex-col items-stretch justify-start gap-0.5 py-1 pr-2 pl-6 text-left font-normal whitespace-normal"
          />
        }
      >
        <span className="flex w-full items-center gap-2">
          <Favicon url={src.url} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{src.title ?? host}</span>
          {src.title ? <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{host}</span> : null}
        </span>
        {src.claim ? <span className="line-clamp-2 pl-6 text-xs text-muted-foreground">{src.claim}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{src.url}</TooltipContent>
    </Tooltip>
  );
}
