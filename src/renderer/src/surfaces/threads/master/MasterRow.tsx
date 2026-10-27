import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Item } from "../../../components/ui/item";
import { StatusMark, statusNeedsYou, statusToneClass } from "../../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { MessageSquare, MoreHorizontal, Pause, Play } from "../../../chrome/icons";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { HostGlyph } from "../../../chrome/HostGlyph";
import { cn } from "../../../lib/cn";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness, useSessionMeta } from "../../../lib/tcserver/store";
import type { BoardDigest } from "@server/shared/contract-batch";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { modelLabel } from "../../../lib/threads/agents";
import { AGENT_GLYPHS, THREAD_GLYPHS } from "../threadTypes";
import { agentTail, useRowAgents, type AgentLine, type RowAgents } from "./agentSummary";
import { rowStatus, taskList, taskTally } from "./rowBody";
import { groupOf, typeWord, useBoardDigest, useRowMeta, type BoardRowRef, type RowHost } from "./useMasterModel";

/**
 * One row of the batch (docs/LAYOUT.md "Master"). Line one: the type's
 * glyph (its word on hover), the title, the host's glyph, and at the end
 * the provider's mark, the model, its effort and context. Line two: the
 * status glyph with what the state is about (the section heading says
 * the word), and the task tally at the end. Under them the thread's live
 * subagents, one line each (AgentLines). A row of a host out of reach is
 * under the offline tint. A click opens the thread's full view in the
 * board's place; on hover the model mark gives way to Message, the one
 * verb the state calls for (Pause, Resume, Start now) and ⋯, the thread's
 * menu (rowMenu.ts), which a right-click on the row or an agent line opens
 * too. Every action goes to the row's own host (the commands route by the
 * thread's id).
 *
 * `MasterRow` reads its own meta, its plan's, its digest (the host's
 * `batch.board`) and its agents' lines, and takes nothing else that
 * changes: one child's activity re-renders this row alone, and nothing
 * here loads a transcript, polls a context or reads notes. `MasterRowView`
 * draws from props alone, so a static preview renders it without a store.
 */

export type OnRowMenu = (id: string, at: { x: number; y: number }) => void;

/** The host's glyph for a thread, as a render function so the view itself reads no store. */
export type HostGlyphOf = (environmentId: string, title?: string) => ReactNode;

const hostGlyph: HostGlyphOf = (environmentId, title) => <HostGlyph environmentId={environmentId} title={title} className="shrink-0" />;

export const MasterRow = memo(function MasterRow({
  rowRef,
  landed,
  host,
  onOpen,
  onMenu,
}: {
  rowRef: BoardRowRef;
  /** The batch marked this row's branch landed. */
  landed: boolean;
  /** The thread's host when it is not the master's; null otherwise. */
  host: RowHost | null;
  /** Open the thread's full view; `focus` lands in its composer. */
  onOpen: (id: string, focus?: boolean) => void;
  /** The thread's menu at a point. */
  onMenu: OnRowMenu;
}) {
  const meta = useRowMeta(rowRef);
  const plan = useSessionMeta(rowRef.planId);
  const digest = useBoardDigest(rowRef.id);
  const agents = useRowAgents(rowRef.id);
  if (!meta) return null;
  return (
    <MasterRowView
      meta={meta}
      planTitle={plan?.title}
      planId={plan?.id}
      digest={digest}
      agents={agents}
      landed={landed}
      host={host}
      hostGlyph={hostGlyph}
      onOpen={onOpen}
      onMenu={onMenu}
    />
  );
});

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function MasterRowView({
  meta,
  planTitle,
  planId,
  digest,
  agents,
  landed,
  host,
  hostGlyph,
  onOpen,
  onMenu,
}: {
  meta: SessionMeta;
  /** The plan's title when the row is a plan and the build it started. */
  planTitle?: string;
  planId?: string;
  digest: BoardDigest;
  agents: RowAgents | null;
  landed: boolean;
  host: RowHost | null;
  hostGlyph: HostGlyphOf;
  onOpen: (id: string, focus?: boolean) => void;
  onMenu: OnRowMenu;
}) {
  const title = planTitle || meta.title;
  const { state, detail } = rowStatus(meta, digest, landed);
  const tally = taskTally(taskList(digest));
  const group = groupOf(meta.status);
  const quiet = group === "done" || group === "queued";
  const Glyph = meta.threadType ? THREAD_GLYPHS[meta.threadType] : null;
  const type = typeWord(meta);

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(meta.id);
    }
  };
  const openMenu = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onMenu(meta.id, { x: rect.left, y: rect.bottom + 4 });
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
      onClick={() => onOpen(meta.id)}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(meta.id, { x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "group relative grid cursor-default grid-cols-[16px_1fr] items-start gap-x-2 gap-y-0 rounded-md px-3 py-2 hover:bg-foreground/5",
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
        {Glyph ? (
          <Tooltip>
            <TooltipTrigger render={<span className="flex" role="img" aria-label={type || undefined} />}>
              <Glyph className="size-4 text-muted-foreground" strokeWidth={1.5} />
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

      {/* Line two: the status glyph with its detail; the tally at the end. */}
      <span />
      <span className="mt-0.5 flex h-4 min-w-0 items-center gap-2" data-row-status>
        <StatusMark state={state} word={detail || false} className="min-w-0" />
        {tally ? <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" data-tally>{tally}</span> : null}
      </span>

      {agents ? (
        <>
          <span />
          <AgentLines agents={agents} hostGlyph={hostGlyph} onOpen={onOpen} onMenu={onMenu} />
        </>
      ) : null}

      <span
        data-actions
        onKeyDown={stop}
        className="pointer-events-none absolute top-1.5 right-2 flex gap-0.5 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <RowAction label="Message" onClick={() => onOpen(meta.id, true)}>
          <MessageSquare />
        </RowAction>
        {verb ? (
          <RowAction label={verb.label} onClick={() => void verb.run().catch(() => undefined)}>
            <verb.icon />
          </RowAction>
        ) : null}
        <RowAction label="Thread actions" tooltip="More" onClick={openMenu} menu>
          <MoreHorizontal />
        </RowAction>
      </span>
    </Item>
  );
}

function RowAction({
  label,
  tooltip = label,
  menu,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  menu?: boolean;
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
            aria-haspopup={menu ? "menu" : undefined}
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

/** The thread's live subagents under its two lines (agentSummary.ts): per
 *  agent its status glyph, its role's glyph, its title and what its state
 *  is about (amber when it needs the person, red when it failed), then the
 *  host's glyph; one quiet line for the ones past the cap and the settled
 *  ones. A line opens its agent in the board's place, where its approval
 *  or question is answered; its click never reaches the row. */
function AgentLines({ agents, hostGlyph, onOpen, onMenu }: { agents: RowAgents; hostGlyph: HostGlyphOf; onOpen: (id: string) => void; onMenu: OnRowMenu }) {
  const tail = agentTail(agents);
  return (
    <ul className="flex flex-col pt-1" data-agents>
      {agents.lines.map((line) => (
        <AgentLineRow key={line.id} line={line} hostGlyph={hostGlyph} onOpen={onOpen} onMenu={onMenu} />
      ))}
      {tail ? (
        <li className={cn("pl-5 text-xs leading-5 tabular-nums", tail.waiting ? statusToneClass("waiting") : "text-muted-foreground")} data-agents-tail>
          {tail.text}
        </li>
      ) : null}
    </ul>
  );
}

function AgentLineRow({ line, hostGlyph, onOpen, onMenu }: { line: AgentLine; hostGlyph: HostGlyphOf; onOpen: (id: string) => void; onMenu: OnRowMenu }) {
  const Glyph = line.agentType ? AGENT_GLYPHS[line.agentType] : line.threadType ? THREAD_GLYPHS[line.threadType] : null;
  return (
    <li>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(line.id);
        }}
        onKeyDown={stop}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(line.id, { x: e.clientX, y: e.clientY });
        }}
        className="-mx-1 flex h-5 w-[calc(100%+8px)] min-w-0 cursor-default items-center gap-2 rounded-sm px-1 text-left text-xs hover:bg-foreground/5"
        data-agent={line.id}
      >
        <StatusMark state={line.state} word={false} />
        {Glyph ? <Glyph className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.5} /> : null}
        <span className="max-w-[45%] min-w-0 truncate text-muted-foreground">{line.title || "Subagent"}</span>
        <span className={cn("min-w-0 flex-1 truncate", statusNeedsYou(line.state) ? statusToneClass(line.state) : "text-muted-foreground")} data-agent-what>
          {line.detail}
        </span>
        {hostGlyph(line.environmentId)}
      </button>
    </li>
  );
}

/** The provider's mark, the model, then its effort and context; it gives
 *  way to the row's actions on hover and focus. */
function ModelMark({ meta }: { meta: SessionMeta }) {
  const rest = [meta.reasoning, meta.context1m ? "1M" : null].filter(Boolean).join(" ");
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground transition-opacity duration-(--dur-fast) group-focus-within:opacity-0 group-hover:opacity-0"
      data-model
    >
      <HarnessIcon harness={asHarness(meta.provider)} className="size-3" />
      <span>{modelLabel(meta.provider, meta.model)}</span>
      {rest ? <span className="ml-0.5">{rest}</span> : null}
    </span>
  );
}
