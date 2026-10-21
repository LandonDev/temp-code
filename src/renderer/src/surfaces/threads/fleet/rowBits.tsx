import type { ReactNode } from "react";
import { Check, CircleDashed, Pause } from "../../../chrome/icons";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { hasStats, isLiveStatus, modelLabel } from "../../../lib/threads/agents";
import { asHarness } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { MatrixSpinner, StatusDot } from "../bits";
import { statsParts, type FleetStats } from "./useFleetModel";

/**
 * The pieces a thread row is built from, shared by the fleet's AgentRow
 * (a subagent) and the master board's MasterRow (a root thread of the
 * batch): the status glyph, the one-line stats, the model line. One look
 * for "a thread as a row" wherever it appears.
 */

/** The glyph that says what the thread is doing: the matrix spinner while
 *  live, a dot while it waits or failed, a still dashed ring while queued,
 *  a pause mark while paused, a check once settled. */
export function StatusGlyph({ status }: { status: SessionMeta["status"] }) {
  if (isLiveStatus(status)) return <MatrixSpinner cell={2} />;
  if (status === "waiting" || status === "error") return <StatusDot status={status} />;
  if (status === "queued") return <CircleDashed className="size-3 text-content/40" strokeWidth={1.75} />;
  if (status === "paused") return <Pause className="size-3 text-content/40" strokeWidth={1.75} />;
  if (status === "stopped") return <span className="size-1.5 rounded-full bg-content/40" />;
  return <Check className="size-3.5 text-success" strokeWidth={2} />;
}

export function CtxRing({ pct }: { pct: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-content/15" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round"
        className={pct >= 85 ? "stroke-warning" : "stroke-content/50"}
      />
    </svg>
  );
}

/** The stats as one quiet line: "+120 −45 · 3/7 tasks · 43% · ◔ 42%".
 *  `tail` adds parts after the stats (a branch, "landed 12:08") with the
 *  same separator; the line renders for them even with no stats. */
export function AgentStatsLine({
  stats,
  tail = [],
  className = "",
}: {
  stats: FleetStats;
  tail?: ReactNode[];
  className?: string;
}) {
  const extras = tail.filter((t) => t !== null && t !== undefined && t !== false);
  if (!hasStats(stats) && !stats.compacting && extras.length === 0) return null;
  const parts = statsParts(stats);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-xs tabular-nums whitespace-nowrap text-content/40 ${className}`}
    >
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex shrink-0 items-center gap-1.5">
          {i > 0 && <span className="text-content/20">·</span>}
          {p.key === "diff" ? (
            <span>
              <span className="text-success">+{p.adds}</span> <span className="text-danger">−{p.dels}</span>
            </span>
          ) : p.key === "tasks" ? (
            <span>
              {p.done}/{p.total} tasks · {p.pct}%
            </span>
          ) : p.key === "compact" ? (
            <span className="text-violet">compacting…</span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <CtxRing pct={p.pct} />
              {p.pct}%
            </span>
          )}
        </span>
      ))}
      {extras.map((t, i) => (
        <span key={`tail-${i}`} className="inline-flex min-w-0 items-center gap-1.5">
          {(parts.length > 0 || i > 0) && <span className="text-content/20">·</span>}
          <span className="truncate">{t}</span>
        </span>
      ))}
    </span>
  );
}

/** "Fable 5.1 · high · 1M": the model, its effort and, on the full window,
 *  the context. `icon` puts the harness glyph before it (the fleet does). */
export function ModelLine({
  meta,
  icon = false,
  className = "",
}: {
  meta: Pick<SessionMeta, "provider" | "model" | "reasoning" | "context1m">;
  icon?: boolean;
  className?: string;
}) {
  const parts = [modelLabel(meta.provider, meta.model), meta.reasoning];
  if (meta.context1m) parts.push("1M");
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {icon ? <HarnessIcon harness={asHarness(meta.provider)} className="size-3.5" /> : null}
      {parts.join(" · ")}
    </span>
  );
}
