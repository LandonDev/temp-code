import { memo, useEffect, useRef, useState, type ComponentType } from "react";
import { Button } from "@renderer/components/ui/button";
import { Collapsible, CollapsibleContent } from "@renderer/components/ui/collapsible";
import { Item, ItemActions, ItemContent, ItemMedia } from "@renderer/components/ui/item";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { Bot, Clock, Eye, Globe, Laptop, Layers, Square, Terminal, Users, Workflow } from "../../chrome/icons";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { rowStale, stopActivity, useActivity, type ActivityKind, type ActivityRow } from "../../lib/activity";
import { devPane } from "../../lib/devPane";
import { taskLog } from "../../lib/tcserver/commands";
import type { SessionMeta } from "../../lib/tcserver/types";
import { useSlowClock } from "../../lib/turnClock";

/**
 * The right panel's Activity section: what a thread has running in the
 * background, one 28px row each (docs/DESIGN.md "Panels"). No heading, no
 * card, no separators. A row carries its kind's glyph, the work in the
 * model's words (a shell's command under it), its age, and Stop. A shell,
 * monitor, agent or workflow row opens its live output under it
 * (session.taskLog, every 1.5 s while open and on screen); the subagents
 * row opens the Agents section; a dev server opens the dev servers pane.
 * Rows have no enter or leave motion: a row leaves when its push says the
 * work ended, and an open log closes with it.
 */

const GLYPH: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  shell: Terminal,
  monitor: Eye,
  agent: Bot,
  workflow: Workflow,
  cron: Clock,
  other: Clock,
  subagents: Users,
  batch: Layers,
  dev: Globe,
  mac: Laptop,
};

/** How often an open log asks for more. */
const LOG_POLL_MS = 1_500;
/** The most of a log the fold keeps. */
const LOG_KEEP = 64 * 1024;

/** An age in whole minutes: "<1m", "12m", "2h 14m". */
export function ageText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

// Colour codes and cursor moves a terminal would act on; the fold shows the text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function ActivitySection({
  threadId,
  onOpenAgents,
}: {
  threadId: string;
  /** The subagents row: switch the panel to its Agents section. */
  onOpenAgents?: () => void;
}) {
  const { rows, meta } = useActivity(threadId);
  if (!meta) return null;
  return <ActivityRows threadId={threadId} rows={rows} meta={meta} onOpenAgents={onOpenAgents} />;
}

/** The rows alone, given the join (ActivitySection; tests). */
export const ActivityRows = memo(function ActivityRows({
  threadId,
  rows,
  meta,
  onOpenAgents,
}: {
  threadId: string;
  rows: ActivityRow[];
  meta: Pick<SessionMeta, "status" | "background">;
  onOpenAgents?: () => void;
}) {
  const shown = usePaneVisible();
  const now = useSlowClock(shown && rows.length > 0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // An open log closes with its row.
  const open = rows.some((r) => r.key === openKey) ? openKey : null;

  const activate = (row: ActivityRow): void => {
    if (row.open === "log") setOpenKey(open === row.key ? null : row.key);
    else if (row.open === "agents") onOpenAgents?.();
    else if (row.open === "dev") devPane.open(row.devKey);
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col px-1 py-3" data-slot="activity-section">
        {rows.map((row) => (
          <Row
            key={row.key}
            threadId={threadId}
            row={row}
            now={now}
            stale={now > 0 && rowStale(row, meta, now)}
            expanded={open === row.key}
            onActivate={row.open && (row.open !== "agents" || onOpenAgents) ? () => activate(row) : undefined}
            live={shown}
          />
        ))}
      </div>
    </TooltipProvider>
  );
});

function Row({
  threadId,
  row,
  now,
  stale,
  expanded,
  onActivate,
  live,
}: {
  threadId: string;
  row: ActivityRow;
  now: number;
  stale: boolean;
  expanded: boolean;
  onActivate?: () => void;
  live: boolean;
}) {
  const Glyph = GLYPH[row.kind];
  const [stopping, setStopping] = useState(false);
  const stop = (): void => {
    if (stopping) return;
    setStopping(true);
    stopActivity(row).finally(() => setStopping(false));
  };
  const item = (
    <Item
      size="xs"
      data-kind={row.kind}
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      aria-expanded={row.open === "log" ? expanded : undefined}
      onClick={onActivate}
      onKeyDown={
        onActivate
          ? (e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              onActivate();
            }
          : undefined
      }
      className={cn("min-h-7 flex-nowrap", row.detail ? "py-1" : "py-0", onActivate && "hover:bg-foreground/5", expanded && "bg-muted")}
    >
      <ItemMedia className={row.detail ? "self-start pt-0.5" : undefined}>
        <Glyph className="size-3.5 text-muted-foreground" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate text-[13px] text-foreground" />}>{row.label}</TooltipTrigger>
          <TooltipContent>{row.label}</TooltipContent>
        </Tooltip>
        {row.detail ? <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{row.detail}</span> : null}
      </ItemContent>
      <ItemActions className={cn("gap-1", row.detail && "self-start")}>
        {now > 0 ? (
          <span className={cn("text-xs tabular-nums", stale ? "text-warning" : "text-muted-foreground")}>{ageText(now - row.since)}</span>
        ) : null}
        {row.stop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Stop"
                  disabled={stopping}
                  onClick={(e) => {
                    e.stopPropagation();
                    stop();
                  }}
                />
              }
            >
              <Square className="size-2.5 fill-current" />
            </TooltipTrigger>
            <TooltipContent>Stop</TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
      </ItemActions>
    </Item>
  );
  if (row.open !== "log" || !row.taskId) return item;
  return (
    <Collapsible open={expanded}>
      {item}
      <CollapsibleContent>
        {expanded ? <TaskLogFold threadId={threadId} taskId={row.taskId} live={live} /> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A task's live output, pinned to its end while the reader has not scrolled up. */
function TaskLogFold({ threadId, taskId, live }: { threadId: string; taskId: string; live: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const next = useRef<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ready = !!text;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const log = await taskLog(threadId, taskId, next.current);
        if (!alive) return;
        // Either source answers only what is new since `from`.
        next.current = log.next;
        setText((prev) => ((prev ?? "") + log.data.replace(ANSI, "")).slice(-LOG_KEEP));
      } catch {
        if (alive) setText((prev) => prev ?? "");
      }
      if (alive) timer = setTimeout(() => void poll(), LOG_POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [live, taskId, threadId]);

  useEffect(() => {
    const viewport = box.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!viewport) return;
    const onScroll = (): void => {
      pinned.current = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [ready]);

  useEffect(() => {
    const viewport = box.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (viewport && pinned.current) viewport.scrollTop = viewport.scrollHeight;
  }, [text]);

  if (text === null) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        Loading…
      </div>
    );
  }
  if (!text) return <p className="px-2 py-1.5 text-xs text-muted-foreground">No output yet</p>;
  return (
    <div ref={box} className="px-2 pt-0.5 pb-2">
      <ScrollArea className="max-h-60 [&>[data-slot=scroll-area-viewport]]:max-h-60">
        <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{text}</pre>
      </ScrollArea>
    </div>
  );
}
