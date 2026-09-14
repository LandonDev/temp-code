import { useRef, useState } from "react";
import { contextPercent, contextRatio, formatTokens, type ContextUsage } from "../lib/contextUsage";
import {
  useContextReading,
  type ContextCategory,
  type ContextReading,
} from "../surfaces/threads/fleet/contextCache";
import { ContextRing } from "./ContextMeter";
import { Popover } from "./Popover";

const WIDTH = 320;
const LIST_ROWS = 6;

/**
 * The composer's context meter: the ring and percent in the bottom bar,
 * fed by the fold's live `context` events, and on click the harness's
 * /context breakdown — categories, memory files, MCP tools — through the
 * fleet's shared `session.context` cache. The cache polls only while the
 * popover is open and the turn is settled; mid-turn the server answers
 * null anyway, so the last breakdown stands under the live total.
 */
export function ContextControl({
  sessionId,
  usage,
  busy,
  onClose,
}: {
  sessionId: string;
  usage?: ContextUsage;
  busy?: boolean;
  onClose?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const reading = useContextReading(sessionId, open && !busy);
  const ratio = contextRatio(usage);
  const percent = contextPercent(usage);
  if (!usage && !reading) return null;

  const total = usage?.used ?? reading?.totalTokens ?? 0;
  const max = usage?.window ?? reading?.maxTokens ?? 0;
  const label = percent !== null ? `${percent}%` : formatTokens(total);
  const title = max ? `${formatTokens(total)} / ${formatTokens(max)} tokens` : `${formatTokens(total)} tokens`;
  const dismiss = (refocus: boolean) => {
    setOpen(false);
    if (refocus) onClose?.();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={title}
        aria-label={`Context: ${title}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-context-control
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? dismiss(true) : setOpen(true))}
        className={`flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums ${
          open
            ? "bg-content/10 text-content"
            : "bg-content/10 text-content/50 hover:bg-content/15 hover:text-content"
        }`}
      >
        <ContextRing ratio={ratio} label={title} />
        <span>{label}</span>
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="top"
          width={WIDTH}
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="dialog"
          aria-label="Context"
          data-context-control
          className="flex flex-col gap-3 p-3"
        >
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="text-content">Context</span>
            <span className="tabular-nums text-content/50">
              {max ? `${formatTokens(total)} / ${formatTokens(max)}` : formatTokens(total)}
              {percent !== null ? ` · ${percent}%` : ""}
            </span>
          </div>
          <Breakdown reading={reading} usage={usage} busy={!!busy} />
        </Popover>
      ) : null}
    </div>
  );
}

function Breakdown({
  reading,
  usage,
  busy,
}: {
  reading: ContextReading | null;
  usage?: ContextUsage;
  busy: boolean;
}) {
  const categories = reading?.categories?.filter((c) => c.tokens > 0) ?? [];
  if (categories.length === 0) {
    return (
      <p className="text-[12px] leading-5 text-content/50">
        {busy
          ? "Live total — the breakdown loads when this turn settles."
          : usage
            ? "Context loads after the next reply."
            : "Context appears with the first reply."}
      </p>
    );
  }
  const sum = categories.reduce((n, c) => n + c.tokens, 0);
  const max = Math.max(sum, reading?.maxTokens ?? 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-content/10">
        {categories.map((c, i) => (
          <div
            key={c.name}
            className="h-full"
            style={{ width: `${(100 * c.tokens) / max}%`, backgroundColor: colorOf(c, i) }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-[12px] leading-5">
        {categories.map((c, i) => (
          <li key={c.name} className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(c, i) }} />
            <span className="min-w-0 flex-1 truncate text-content/70">{c.name}</span>
            <span className="tabular-nums text-content/50">{formatTokens(c.tokens)}</span>
          </li>
        ))}
      </ul>
      {busy ? <p className="text-[11px] leading-4 text-content/40">Breakdown from before this turn.</p> : null}
      <BreakdownList
        title="Memory files"
        rows={(reading?.memoryFiles ?? []).map((m) => ({ key: m.path, label: shortPath(m.path), tokens: m.tokens }))}
      />
      <BreakdownList
        title="MCP tools"
        rows={(reading?.mcpTools ?? []).map((t) => ({
          key: `${t.server}/${t.name}`,
          label: t.server ? `${t.server} · ${mcpToolName(t.name, t.server)}` : t.name,
          tokens: t.tokens,
        }))}
      />
    </div>
  );
}

function BreakdownList({ title, rows }: { title: string; rows: { key: string; label: string; tokens: number }[] }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const shown = sorted.slice(0, LIST_ROWS);
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  return (
    <div className="flex flex-col gap-1 text-[12px] leading-5">
      <div className="flex items-baseline justify-between text-content/40">
        <span>{title}</span>
        <span className="tabular-nums">{formatTokens(total)}</span>
      </div>
      <ul className="flex flex-col">
        {shown.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content/70">{r.label}</span>
            <span className="tabular-nums text-content/50">{formatTokens(r.tokens)}</span>
          </li>
        ))}
        {sorted.length > shown.length ? (
          <li className="text-[11px] text-content/40">+{sorted.length - shown.length} more</li>
        ) : null}
      </ul>
    </div>
  );
}

const FALLBACK_COLORS = ["#7c86ff", "#34d399", "#f59e0b", "#f472b6", "#60a5fa", "#a3a3a3"];

function colorOf(c: ContextCategory, index: number): string {
  return c.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
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
