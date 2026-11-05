import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ExternalLink, Square } from "../../../chrome/icons";
import { TruncateTip } from "../../../components/tip";
import { Button } from "../../../components/ui/button";
import { Item } from "../../../components/ui/item";
import { STATUS_WORD, StatusMark, type ThreadState } from "../../../components/ui/status";
import { loadToast } from "../../../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import { clockTime, duration, useNow } from "../../../lib/duration";
import * as commands from "../../../lib/tcserver/commands";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { agentTime, type AgentStatus } from "../../../lib/threads/agents";
import { plainStatus } from "@shared/statusWords";
import { ModelMark, modelMarkTip, storeHostGlyph, type HostGlyphOf } from "../ModelMark";
import { AGENT_WORDS } from "../threadTypes";
import { useAgentStatus } from "./useFleetModel";

/**
 * One subagent in the right panel's Agents section (docs/LAYOUT.md "The
 * right side"). A live agent (working, waiting, failed, watching, paused,
 * queued) is two lines, 44px; a settled one (done, idle, stopped) is one
 * 28px line, its title muted.
 *
 * Line one (20px): the state's glyph in the lead column (working's spinner
 * is the row's one moving mark; done draws its check, the panel's only done
 * cue), the title in 13px medium, the host's glyph (two or more hosts),
 * then at the end the provider's mark, the model and its effort ("Opus 5.5
 * High"), the role first in its tooltip ("Reviewer, Claude Opus 5.5, high
 * effort"), and on a settled row how long it ran. The title gives its width
 * up first, down to 64px; then the model's name truncates, and under 13rem
 * (a deep descendant in a narrow panel) the mark is the logo alone. Line two (16px), live rows only, in the title's column:
 * the host's phrase while it works, else the state's word where the
 * section heading does not say it and what the state is about (amber or
 * red for a question or a failure), and at the end the task tally and the
 * time, which ticks.
 *
 * On hover (after `--delay-hover`) or keyboard focus the model mark gives
 * way to Open (the agent's own thread) and, while a turn runs, Stop. A
 * click or Enter opens the agent's detail. `AgentRowView` draws from props
 * alone; `AgentRow` reads the status and the store's host glyph.
 */

/** A descendant's indent, 16px a level, written whole for the stylesheet;
 *  its width gives way to the margin instead of running past the panel. */
const DEPTH_CLASS = ["", "w-auto ms-4", "w-auto ms-8", "w-auto ms-12"] as const;

/** States drawn on one line: nothing more to say than how long it ran. */
const SETTLED = new Set<ThreadState>(["done", "idle", "stopped"]);

/** Gives way to the row's actions: waits `--delay-hover` on hover, at once on focus and on leaving. */
const YIELDS =
  "transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover:opacity-0 group-hover:delay-(--delay-hover) group-focus-within:opacity-0 group-focus-within:delay-(--dur-instant) motion-reduce:transition-opacity";

/** The actions: hidden at rest, shown after `--delay-hover` on hover, at once on focus. */
const REVEALS =
  "pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover:pointer-events-auto group-hover:opacity-100 group-hover:delay-(--delay-hover) group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-focus-within:delay-(--dur-instant) motion-reduce:transition-opacity";

const noHost: HostGlyphOf = () => null;

/** "3/7", or nothing without tasks. */
function tallyOf(meta: Pick<SessionMeta, "tasks">): { short: string; spoken: string } | null {
  const t = meta.tasks;
  return t && t.total > 0 ? { short: `${t.done}/${t.total}`, spoken: `${t.done} of ${t.total} tasks` } : null;
}

/** The row's time: live states tick on the shared second hand, settled ones say how long they ran. */
function AgentClock({ meta, state }: { meta: SessionMeta; state: ThreadState }) {
  const live = state === "working" || state === "waiting" || state === "watching";
  const now = useNow(live);
  const time = agentTime(meta, live ? now : Date.now());
  if (!time) return null;
  const text = <span data-agent-time>{duration(time.ms)}</span>;
  if (!time.finishedAt) return text;
  return (
    <Tooltip>
      <TooltipTrigger render={text} />
      <TooltipContent>Finished {clockTime(time.finishedAt)}</TooltipContent>
    </Tooltip>
  );
}

export function AgentRowView({
  meta,
  status,
  heading = null,
  depth = 0,
  selected = false,
  hostGlyph = noHost,
  onOpen,
  onOpenSession,
  onStop,
}: {
  meta: SessionMeta;
  status: AgentStatus;
  /** The section heading drawn above the row, whose word the row then leaves out; null when none is drawn. */
  heading?: string | null;
  /** 0 for a direct child, 1 for its child, at most 3. */
  depth?: number;
  selected?: boolean;
  hostGlyph?: HostGlyphOf;
  /** Opens the agent's detail. */
  onOpen: () => void;
  /** Opens the agent's own thread beside its parent. */
  onOpenSession?: () => void;
  /** Stops the agent's running turn. */
  onStop?: () => void;
}) {
  const { state, detail } = status;
  const title = meta.title || "Subagent";
  const settled = SETTLED.has(state);
  const role = AGENT_WORDS[meta.agentType];
  const tally = tallyOf(meta);
  // A working row says the host's phrase alone; another says its word where
  // the heading does not, or when there is nothing else to say.
  const ownWord = !status.phrase && (heading !== STATUS_WORD[state] || !detail);
  const toned = state === "waiting" || state === "failed";
  const statusText = plainStatus(STATUS_WORD[state], detail || null);
  const time = agentTime(meta, Date.now());
  const name = [title, statusText, tally?.spoken, time ? duration(time.ms) : null, modelMarkTip(meta, role)].filter(Boolean).join(", ");
  const stoppable = !!onStop && hasRunningTurn(meta);

  const own = (e: { currentTarget: EventTarget; target: EventTarget }) => (e.currentTarget as Node).contains(e.target as Node);
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <Item
      size="xs"
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-current={selected || undefined}
      onClick={(e) => {
        if (own(e)) onOpen();
      }}
      onKeyDown={onKey}
      data-status={meta.status}
      data-depth={depth || undefined}
      className={cn(
        "group @container/agent relative grid cursor-default grid-cols-[16px_1fr] items-start gap-x-2 gap-y-0 rounded-md px-2 text-left hover:bg-foreground/5",
        settled ? "h-7 content-center py-0" : "py-1",
        DEPTH_CLASS[Math.min(depth, 3)],
        selected && "bg-muted hover:bg-muted",
      )}
    >
      {/* Line one: the state's glyph, the title, the host; the model at the end. */}
      <span className="flex h-5 items-center justify-center" data-row-glyph>
        <StatusMark state={state} word={false} aria-hidden />
      </span>
      <span className="flex h-5 min-w-0 items-center gap-2">
        <TruncateTip text={title}>
          <span className={cn("min-w-16 shrink-[1000] truncate text-[13px] leading-5 font-medium", settled ? "text-muted-foreground" : "text-foreground")} data-row-title>
            {title}
          </span>
        </TruncateTip>
        {hostGlyph(meta.environmentId)}
        <span className="flex-1" />
        <ModelMark
          meta={meta}
          lead={role}
          effort
          className={YIELDS}
          nameClassName="@max-[13rem]/agent:hidden"
          effortClassName="@max-[13rem]/agent:hidden"
        />
        {settled ? (
          <span className={cn("-ms-1 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums", YIELDS)}>
            <AgentClock meta={meta} state={state} />
          </span>
        ) : null}
      </span>

      {/* Line two: what the state is about, then the tally and the time. */}
      {settled ? null : (
        <>
          <span />
          <span className="flex h-4 min-w-0 items-center gap-2" data-row-status>
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0" />}>
                <StatusMark
                  state={state}
                  glyph={false}
                  word={ownWord}
                  detail={detail || undefined}
                  className={cn("min-w-0", toned && "**:data-[slot=status-detail]:text-current")}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">{statusText}</TooltipContent>
            </Tooltip>
            <span className="ms-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
              {tally ? <span data-tally>{tally.short}</span> : null}
              <AgentClock meta={meta} state={state} />
            </span>
          </span>
        </>
      )}

      <span data-actions className={cn("absolute top-1 right-2 flex gap-0.5", settled && "top-0.5", REVEALS)}>
        {onOpenSession ? (
          <RowAction label="Open" onClick={onOpenSession}>
            <ExternalLink />
          </RowAction>
        ) : null}
        {stoppable ? (
          <RowAction label="Stop" onClick={onStop}>
            <Square />
          </RowAction>
        ) : null}
      </span>
    </Item>
  );
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              onClick();
            }}
            onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Stops an agent's turn; a refusal says so in a toast. */
export function stopAgent(meta: Pick<SessionMeta, "id" | "title">): void {
  void commands.interrupt(meta.id).catch(() => loadToast().then((toast) => toast.error("Couldn't stop it", { description: meta.title || "Subagent" })));
}

/** A subagent's row, its status read from the session store. */
export function AgentRow({
  agent,
  heading,
  depth,
  onOpen,
  onOpenSession,
  selected = false,
}: {
  agent: SessionMeta;
  heading?: string | null;
  depth?: number;
  onOpen: () => void;
  onOpenSession?: (sessionId: string) => void;
  selected?: boolean;
}) {
  const status = useAgentStatus(agent);
  return (
    <AgentRowView
      meta={agent}
      status={status}
      heading={heading}
      depth={depth}
      selected={selected}
      hostGlyph={storeHostGlyph}
      onOpen={onOpen}
      onOpenSession={onOpenSession ? () => onOpenSession(agent.id) : undefined}
      onStop={() => stopAgent(agent)}
    />
  );
}
