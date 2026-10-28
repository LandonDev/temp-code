import { useState } from "react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/cn";
import { useContextReading, type ContextReading } from "../lib/contextCache";
import { contextPercent, contextRatio, contextTone, formatTokens, type ContextUsage } from "../lib/contextUsage";
import { LazyPopover, type FocusTarget } from "./menuRows";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Rows a memory or MCP list shows before "+N more". */
const LIST_ROWS = 6;

/**
 * The composer's context meter (docs/LAYOUT.md "Composer"): how full the
 * thread's context window is, as a 14px ring and the percent, muted until
 * 85% and amber from there (`contextTone`), a spinner while the harness
 * compacts. Drawn only once the harness has reported both halves: Cursor's
 * stream carries no usage, and a ring guessing at a number is worse than
 * none. A click opens the harness's breakdown (categories, memory files, MCP
 * tools) through the shared `session.context` cache, polled only while the
 * popover is open and the turn has settled, and Compact when the thread can.
 */
export function ContextMeter({
  sessionId,
  usage,
  busy = false,
  compacting = false,
  compactable = false,
  onCompact,
  finalFocus,
}: {
  sessionId: string;
  usage?: ContextUsage;
  busy?: boolean;
  compacting?: boolean;
  /** `canCompact` (lib/threadMenu.ts): no turn in flight. */
  compactable?: boolean;
  onCompact?: () => void;
  /** Where the focus goes when the popover closes: the composer's field. */
  finalFocus?: FocusTarget;
}) {
  const [open, setOpen] = useState(false);
  const reading = useContextReading(sessionId, open && !busy);
  const ratio = contextRatio(usage);
  if (!usage?.window || ratio === null) return null;
  const percent = contextPercent(usage);
  const tone = contextTone(ratio);
  const warn = tone === "text-warning";
  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Context ${percent}% full`}
      data-context-meter
      data-tone={warn ? "warning" : "muted"}
      className={cn(
        "shrink-0 gap-1.5 px-2 font-normal",
        tone,
        !warn && "hover:text-foreground aria-expanded:text-foreground",
      )}
    >
      {compacting ? <Spinner className="size-3.5" aria-label="Compacting" /> : <ContextRing ratio={ratio} />}
      <span className="text-[12px] tabular-nums @max-[26rem]/composer-bar:hidden">{percent}%</span>
    </Button>
  );
  const compact =
    compactable && onCompact
      ? () => {
          setOpen(false);
          onCompact();
        }
      : undefined;
  return (
    <LazyPopover
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      tip={{ label: compacting ? "Compacting" : `${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens` }}
      side="top"
      align="end"
      label="Context"
      finalFocus={finalFocus}
      className="w-80 gap-0 p-3"
    >
      <ContextBreakdown reading={reading} usage={usage} busy={busy} compacting={compacting} onCompact={compact} />
    </LazyPopover>
  );
}

/** The 14px ring: a 25% track and the filled arc, both in the current colour. */
export function ContextRing({ ratio, className }: { ratio: number; className?: string }) {
  const fill = Math.max(0, Math.min(1, ratio));
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden
      data-context-ring
      className={cn("shrink-0", className)}
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} opacity={0.25} />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fill)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}

/**
 * The popover's body: the head line, what compaction is doing, the
 * harness's categories largest first, each list (memory files, MCP tools)
 * under the category it details so no total is said twice, and Compact.
 * The live total heads it; the breakdown is the last settled reading, a
 * skeleton until the first one lands, and one line mid-turn when there is
 * none yet.
 */
export function ContextBreakdown({
  reading,
  usage,
  busy = false,
  compacting = false,
  onCompact,
}: {
  reading: ContextReading | null;
  usage?: ContextUsage;
  busy?: boolean;
  compacting?: boolean;
  /** Absent: the thread cannot compact now, and the foot is not drawn. */
  onCompact?: () => void;
}) {
  const total = usage?.used ?? reading?.totalTokens ?? 0;
  const max = usage?.window ?? reading?.maxTokens ?? 0;
  const categories = (reading?.categories ?? []).filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const lists = reading ? breakdownLists(reading) : [];
  const listOf = (name: string) => lists.find((l) => l.title.toLowerCase() === name.trim().toLowerCase());
  // A list whose category the harness did not send stands on its own after them.
  const loose = lists.filter((l) => !categories.some((c) => listOf(c.name) === l));
  return (
    <div className="flex flex-col gap-4" data-context-breakdown>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">Context</span>
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {max ? `${formatTokens(total)} of ${formatTokens(max)}` : formatTokens(total)}
        </span>
      </div>
      {compacting ? (
        <div className="-mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          Compacting
        </div>
      ) : null}
      {!reading ? (
        busy ? (
          <p className="text-[12px] text-muted-foreground">Breakdown after this turn</p>
        ) : (
          <div className="flex flex-col gap-2" aria-busy data-context-loading>
            {["w-2/3", "w-1/2", "w-3/5"].map((width) => (
              <div key={width} className="flex h-4 items-center justify-between gap-3">
                <Skeleton className={cn("h-3", width)} />
                <Skeleton className="h-3 w-8" />
              </div>
            ))}
          </div>
        )
      ) : categories.length > 0 ? (
        <div className="flex flex-col" data-context-categories>
          {categories.map((c) => {
            const list = listOf(c.name);
            return (
              <div key={c.name} data-context-category={c.name}>
                <div className="flex h-6 items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-muted-foreground">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-foreground">{formatTokens(c.tokens)}</span>
                </div>
                {list ? <ListRows list={list} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {loose.map((list) => (
        <div key={list.title} className="flex flex-col" data-context-list={list.title}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px] text-muted-foreground">
            <span className="font-medium">{list.title}</span>
            <span className="tabular-nums">{formatTokens(list.rows.reduce((n, r) => n + r.tokens, 0))}</span>
          </div>
          <ListRows list={list} />
        </div>
      ))}
      {onCompact ? (
        <div className="-mb-1 -me-2.5 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCompact} className="font-normal">
            Compact
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type BreakdownListData = { title: string; rows: { key: string; label: string; tokens: number }[] };

/** The reading's two lists, by the names the harness gives their categories. */
function breakdownLists(reading: ContextReading): BreakdownListData[] {
  const lists: BreakdownListData[] = [
    {
      title: "Memory files",
      rows: (reading.memoryFiles ?? []).map((m) => ({ key: m.path, label: shortPath(m.path), tokens: m.tokens })),
    },
    {
      title: "MCP tools",
      rows: (reading.mcpTools ?? []).map((t) => ({
        key: `${t.server}/${t.name}`,
        label: t.server ? `${t.server}/${mcpToolName(t.name, t.server)}` : t.name,
        tokens: t.tokens,
      })),
    },
  ];
  return lists.filter((l) => l.rows.length > 0);
}

/** A list's rows, one step in: at most six, largest first, then "+N more". */
function ListRows({ list }: { list: BreakdownListData }) {
  const sorted = [...list.rows].sort((a, b) => b.tokens - a.tokens);
  const shown = sorted.slice(0, LIST_ROWS);
  return (
    <div className="flex flex-col ps-3" data-context-rows={list.title}>
      {shown.map((r) => (
        <div key={r.key} className="flex h-6 items-center justify-between gap-3 text-[12px]">
          <span className="min-w-0 truncate font-mono text-muted-foreground">{r.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatTokens(r.tokens)}</span>
        </div>
      ))}
      {sorted.length > shown.length ? (
        <div className="flex h-6 items-center text-[12px] text-muted-foreground">+{sorted.length - shown.length} more</div>
      ) : null}
    </div>
  );
}

/** `mcp__server__tool` reads as `tool` beside its server. */
function mcpToolName(name: string, server: string): string {
  const prefix = `mcp__${server}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The last two path segments: enough to tell CLAUDE.md files apart. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}
