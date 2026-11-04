import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Item } from "../../../components/ui/item";
import { Progress } from "../../../components/ui/progress";
import { STATUS_WORD, StatusMark, statusToneClass } from "../../../components/ui/status";
import { TaskRows } from "../../../components/ui/task-list";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { ChevronRight, MessageSquare, MoreHorizontal, Pause, Play } from "../../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../../chrome/menuRows";
import { cn } from "../../../lib/cn";
import { useKept } from "../../../lib/keptValue";
import * as commands from "../../../lib/tcserver/commands";
import { useSessionMeta } from "../../../lib/tcserver/store";
import type { BoardDigest } from "@server/shared/contract-batch";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { marksAtRest } from "../../../lib/threadStripModel";
import { plainStatus } from "@shared/statusWords";
import { ModelMark, modelMarkName, modelMarkTip, storeHostGlyph, type HostGlyphOf } from "../ModelMark";
import { tasksOf } from "../implementationBoard";
import { TypeGlyph } from "../TypeGlyph";
import { agentTail, useRowAgents, type AgentLine, type RowAgents } from "./agentSummary";
import { rowStatus, taskBar, taskList, taskTally } from "./rowBody";
import { useTaskFold } from "./taskFold";
import { GROUP_LABEL, groupOf, typeWord, useBoardDigest, useRowMeta, type BoardRowRef, type RowHost } from "./useMasterModel";

/**
 * One 48px row of the batch (docs/LAYOUT.md "Master"), its glyph column
 * 12px from the pane. Line one (20px): the type's glyph (its word on
 * hover), the title in 13px medium, the host's glyph, and at the end the
 * provider's mark and the model (its effort and context in the mark's
 * tooltip). Line two (16px): the status glyph hanging in the glyph column
 * under the type's (drawn for every state but done and idle; working's
 * spinner is the row's one moving mark), then in the title's column the
 * word when the section heading does not say it (watching or paused under
 * Working, failed under Needs you, stopped under Done) and what the state
 * is about, 12px, and the task tally at the end. The child that blocks the
 * batch's end says why (`blocked`). An implementation or orchestration row
 * with a task list has a third line instead of the end tally (16px, the
 * row 64px): the task bar across the title's column, foreground while the
 * thread works and muted otherwise, then the tally and a chevron; the
 * whole line folds the task list open under it (compact TaskRows), closed
 * by default and remembered per row for the window's life (taskFold.ts).
 * Under them the thread's live
 * subagents, one still line each (AgentLines). A row of a host out of reach is
 * under the offline tint. A click opens the thread's full view in the
 * board's place; on hover the model mark gives way to Message, the one
 * verb the state calls for (Pause, Resume, Start now) and ⋯, the thread's
 * menu (lib/threadMenu.ts, the thread's one list), which a right-click on
 * the row or an agent line opens too (MasterView's one context menu reads
 * `data-menu-id`). Every action goes to the row's own host (the commands route by the
 * thread's id).
 *
 * `MasterRow` reads its own meta, its plan's, its digest (the host's
 * `batch.board`) and its agents' lines, and takes nothing else that
 * changes: one child's activity re-renders this row alone, and nothing
 * here loads a transcript, polls a context or reads notes. `MasterRowView`
 * draws from props alone, so a static preview renders it without a store.
 */

/** The board's thread menu (chrome/useThreadMenu.tsx): the rows a thread's ⋯ shows and its picks. */
export type RowMenu = {
  rowsFor: (id: string) => readonly MenuRow[];
  onPick: (id: string, pick: string) => void;
  onOpenChange: (id: string, open: boolean) => void;
};

export type { HostGlyphOf };
export { modelMarkName, modelMarkTip };

const hostGlyph = storeHostGlyph;

/** What a board row never shows: the live context and each event's stamp. */
const UNSHOWN = new Set<string>(["context", "lastEventAt"]);

/** True when the two metas differ only in what a row never shows. */
export function sameShownMeta(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (UNSHOWN.has(key)) continue;
    const x = (a as unknown as Record<string, unknown>)[key];
    const y = (b as unknown as Record<string, unknown>)[key];
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

/** The meta a row last drew, kept while only what it never shows changes, so
 *  the row and everything under it render again only for what they show. */
const sameShown = (kept: SessionMeta | null, next: SessionMeta | null): boolean => kept !== null && next !== null && sameShownMeta(kept, next);

export const MasterRow = memo(function MasterRow({
  masterId,
  rowRef,
  landed,
  blocked = null,
  host,
  onOpen,
  menu,
}: {
  /** The master whose board this is: the fold memory's scope. */
  masterId: string;
  rowRef: BoardRowRef;
  /** The batch marked this row's branch landed. */
  landed: boolean;
  /** Why this child blocks the batch's end ("ended its turn without completing"); null for every other row. */
  blocked?: string | null;
  /** The thread's host when it is not the master's; null otherwise. */
  host: RowHost | null;
  /** Open the thread's full view; `focus` lands in its composer. */
  onOpen: (id: string, focus?: boolean) => void;
  /** The thread's menu: the ⋯ button's rows (a right-click reads `data-menu-id`). */
  menu: RowMenu;
}) {
  const meta = useKept(useRowMeta(rowRef), sameShown);
  const plan = useSessionMeta(rowRef.planId);
  const digest = useBoardDigest(rowRef.id);
  const agents = useRowAgents(rowRef.id);
  const [tasksOpen, setTasksOpen] = useTaskFold(masterId, rowRef.key);
  if (!meta) return null;
  return (
    <ShownRow
      meta={meta}
      planTitle={plan?.title}
      planId={plan?.id}
      digest={digest}
      agents={agents}
      landed={landed}
      blocked={blocked}
      host={host}
      hostGlyph={hostGlyph}
      onOpen={onOpen}
      menu={menu}
      tasksOpen={tasksOpen}
      onTasksOpenChange={setTasksOpen}
    />
  );
});

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/** The view, drawn again only when what it is handed changes: the row's own
 *  subscriptions wake it on every push of its thread, most of which it keeps. */
const ShownRow = memo(function ShownRow(props: Parameters<typeof MasterRowView>[0]) {
  return <MasterRowView {...props} />;
});

export function MasterRowView({
  meta,
  planTitle,
  planId,
  digest,
  agents,
  landed,
  blocked = null,
  host,
  hostGlyph,
  onOpen,
  menu,
  tasksOpen = false,
  onTasksOpenChange,
}: {
  meta: SessionMeta;
  /** The plan's title when the row is a plan and the build it started. */
  planTitle?: string;
  planId?: string;
  digest: BoardDigest;
  agents: RowAgents | null;
  landed: boolean;
  blocked?: string | null;
  host: RowHost | null;
  hostGlyph: HostGlyphOf;
  onOpen: (id: string, focus?: boolean) => void;
  menu: RowMenu;
  /** The task list's fold under the bar line (bar rows only). */
  tasksOpen?: boolean;
  onTasksOpenChange?: (open: boolean) => void;
}) {
  const title = planTitle || meta.title;
  const { state, detail } = rowStatus(meta, digest, landed, blocked);
  // The word the glyph stands for and the detail, as one name for readers.
  const statusLabel = plainStatus(STATUS_WORD[state], detail);
  const bar = taskBar(meta, digest);
  // A bar row says its tally on the bar's line alone.
  const tally = bar ? null : taskTally(taskList(digest));
  const group = groupOf(meta);
  // The section heading says the word; a state it does not name says its own.
  const ownWord = STATUS_WORD[state] !== GROUP_LABEL[group];
  const quiet = group === "done" || group === "queued";
  // Amber and red say their detail in the state's tone; every other detail is muted.
  const toned = state === "waiting" || state === "failed";
  const type = typeWord(meta);

  // React bubbles a portal's events through the tree: a pick in the ⋯
  // menu (rendered in a portal) reaches this row's handlers. Only a click
  // or key inside the row's own DOM opens the thread.
  const own = (e: { currentTarget: EventTarget; target: EventTarget }) => (e.currentTarget as Node).contains(e.target as Node);
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || !own(e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(meta.id);
    }
  };
  const verb =
    meta.status === "queued"
      ? { label: "Start now", icon: Play, run: () => commands.startNow(meta.id) }
      : hasRunningTurn(meta)
        ? { label: "Pause", icon: Pause, run: () => commands.pause(meta.id) }
        : meta.status === "paused" || meta.status === "stopped"
          ? { label: "Resume", icon: Play, run: () => commands.resume(meta.id) }
          : null;

  return (
    <Item
      size="xs"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (own(e)) onOpen(meta.id);
      }}
      onKeyDown={onKey}
      data-menu-id={meta.id}
      className={cn(
        "group relative grid cursor-default grid-cols-[16px_1fr] items-start gap-x-2 gap-y-0 rounded-md px-2 py-1.5 hover:bg-foreground/5",
        host?.offline && "opacity-50",
      )}
      data-status={meta.status}
      data-type={meta.threadType ?? undefined}
      data-plan={planId}
      data-host={host?.id}
      data-host-offline={host?.offline || undefined}
    >
      {/* Line one: the type's glyph, the title, the host; the model at the end. */}
      <span className="flex h-5 items-center justify-center">
        {meta.threadType ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex" role="img" aria-label={type || undefined} />}>
              <TypeGlyph type={meta.threadType} className="size-4" />
            </TooltipTrigger>
            {type ? <TooltipContent>{type}</TooltipContent> : null}
          </Tooltip>
        ) : null}
      </span>
      <span className="flex h-5 min-w-0 items-center gap-2">
        <span className={cn("min-w-0 truncate text-[13px] font-medium", quiet ? "text-muted-foreground" : "text-foreground")} data-row-title>
          {title || "Untitled"}
        </span>
        {hostGlyph(meta.environmentId, host?.offline ? `${host.name} is offline` : undefined)}
        <span className="flex-1" />
        <ModelMark meta={meta} />
      </span>

      {/* Line two: the status glyph hangs under the type's, so the detail
          starts under the title; a settled row draws none ("Landed 12:08"). */}
      <span className="flex h-4 items-center justify-center" data-row-glyph>
        {marksAtRest(state) ? <StatusMark state={state} word={false} aria-hidden /> : null}
      </span>
      <span className="flex h-4 min-w-0 items-center gap-2" data-row-status>
        <StatusMark
          state={state}
          glyph={false}
          word={ownWord}
          detail={detail || undefined}
          aria-label={statusLabel}
          className={cn("min-w-0", toned && "**:data-[slot=status-detail]:text-current")}
        />
        {tally ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" data-tally>
            {tally}
          </span>
        ) : null}
      </span>

      {bar ? (
        <>
          <span />
          <TaskBar bar={bar} working={state === "working"} todos={taskList(digest)} open={tasksOpen} onOpenChange={onTasksOpenChange} />
        </>
      ) : null}

      {agents ? (
        <>
          <span />
          <AgentLines agents={agents} hostGlyph={hostGlyph} onOpen={onOpen} />
        </>
      ) : null}

      <span
        data-actions
        onKeyDown={stop}
        className="pointer-events-none absolute top-1 right-2 flex gap-0.5 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <RowAction label="Message" onClick={() => onOpen(meta.id, true)}>
          <MessageSquare />
        </RowAction>
        {verb ? (
          <RowAction label={verb.label} onClick={() => void verb.run().catch(() => undefined)}>
            <verb.icon />
          </RowAction>
        ) : null}
        <RowsMenu
          label="Thread actions"
          tip={{ label: "More" }}
          trigger={
            <Button variant="ghost" size="icon-xs" aria-label="Thread actions" onClick={stop}>
              <MoreHorizontal />
            </Button>
          }
          rows={() => menu.rowsFor(meta.id)}
          onPick={(pick) => menu.onPick(meta.id, pick)}
          onOpenChange={(open) => menu.onOpenChange(meta.id, open)}
          align="start"
        />
      </span>
    </Item>
  );
}

/** The bar line and the task list it folds open: the 4px bar (foreground
 *  while the thread works, muted in every other state, so it never
 *  competes with an amber or red detail), the tally and a chevron, the
 *  whole line one button. The fold is the standard Fold row (DESIGN.md);
 *  the bar's fill is Progress's own and moves only when a task ticks. Its
 *  click and keys stay off the row, which would open the thread. */
function TaskBar({
  bar,
  working,
  todos,
  open,
  onOpenChange,
}: {
  bar: { done: number; total: number };
  working: boolean;
  todos: ReturnType<typeof taskList>;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={(next) => onOpenChange?.(next)} className="min-w-0" data-task-bar>
      <CollapsibleTrigger
        aria-label={`Tasks: ${String(bar.done)} of ${String(bar.total)} done`}
        onClick={stop}
        onKeyDown={stop}
        className="-mx-1 flex h-4 w-[calc(100%+8px)] items-center gap-2 rounded-sm px-1 outline-none transition-[background-color] duration-(--dur-hover) hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <Progress value={bar.done} max={bar.total} fill={working ? "foreground" : "muted"} aria-hidden className="min-w-0 flex-1" />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" dir="ltr" data-bar-tally>
          {bar.done}/{bar.total}
        </span>
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-[rotate] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent data-task-fold>
        <TaskRows size="compact" tasks={tasksOf(todos, 0, working)} className="py-0.5" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function RowAction({
  label,
  tooltip = label,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              onClick(e);
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The thread's live subagents under its two lines (agentSummary.ts), in
 *  the title's column: per agent a still status glyph (the row's own
 *  spinner is its one moving mark), its title, the state's word in its
 *  tone and what it is about, muted, then the host's glyph; one quiet line
 *  for the ones past the cap and the settled ones ("2 more, 3 done"). A
 *  line opens its agent in the board's place, where its approval or
 *  question is answered; its click never reaches the row. */
function AgentLines({ agents, hostGlyph, onOpen }: { agents: RowAgents; hostGlyph: HostGlyphOf; onOpen: (id: string) => void }) {
  const tail = agentTail(agents);
  return (
    <ul className="flex flex-col pt-0.5 pb-0.5" data-agents>
      {agents.lines.map((line) => (
        <AgentLineRow key={line.id} line={line} hostGlyph={hostGlyph} onOpen={onOpen} />
      ))}
      {tail ? (
        <li className={cn("pl-5 text-xs leading-5 tabular-nums", tail.waiting ? statusToneClass("waiting") : "text-muted-foreground")} data-agents-tail>
          {tail.text}
        </li>
      ) : null}
    </ul>
  );
}

function AgentLineRow({ line, hostGlyph, onOpen }: { line: AgentLine; hostGlyph: HostGlyphOf; onOpen: (id: string) => void }) {
  return (
    <li>
      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(line.id);
        }}
        onKeyDown={stop}
        data-menu-id={line.id}
        className="-mx-1 flex h-5 w-[calc(100%+8px)] min-w-0 justify-start gap-1.5 rounded-sm px-1 text-left text-xs font-normal hover:bg-foreground/5"
        data-agent={line.id}
      >
        <StatusMark state={line.state} word={false} still aria-hidden />
        <span className="max-w-[45%] min-w-0 shrink-0 truncate text-foreground">{line.title || "Subagent"}</span>
        <StatusMark state={line.state} glyph={false} detail={line.detail || undefined} className="min-w-0 flex-1 ps-0.5" data-agent-what />
        {hostGlyph(line.environmentId)}
      </Button>
    </li>
  );
}
