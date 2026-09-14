import { motion, useReducedMotion } from "motion/react";
import { EASE_IN_OUT } from "../lib/ease";
import type { Block } from "../lib/session";
import { formatTokens } from "../lib/contextUsage";
import { useClock } from "../lib/turnClock";

/**
 * A compaction's three faces on one system row: a pulsing line with an
 * estimated bar while the harness squeezes the window, a divider with the
 * before/after once it lands, and a red line when it fails.
 *
 * The bar is an estimate: compaction reports no progress, so it eases
 * toward 90% over ~20 s and only the done event fills it.
 */
export function CompactionCard({ block }: { block: Block }) {
  const meta = block.compaction;
  if (!meta) return null;
  if (meta.phase === "start") return <ActiveCompaction startedAt={meta.startedAt} trigger={meta.trigger} />;
  if (meta.phase === "failed") {
    return (
      <div className="flex items-center gap-2 py-3 font-sans text-[12px] text-danger">
        <span>Compaction failed</span>
        {meta.error ? <span className="min-w-0 truncate text-danger/70">{meta.error}</span> : null}
      </div>
    );
  }
  const parts = [
    meta.preTokens !== undefined && meta.postTokens !== undefined
      ? `${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)}`
      : meta.postTokens !== undefined
        ? `now ${formatTokens(meta.postTokens)}`
        : null,
    meta.durationMs !== undefined ? formatDuration(meta.durationMs) : null,
    meta.trigger,
  ].filter(Boolean);
  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <div className="h-px min-w-4 flex-1 bg-content/10" />
        <div
          role="separator"
          aria-label={`Context compacted ${parts.join(", ")}`}
          className="flex min-w-0 max-w-[min(100%,24rem)] items-center gap-1.5 px-1.5 font-sans text-[12px] text-content/50"
        >
          <span className="shrink-0">Context compacted</span>
          {parts.length ? <span className="min-w-0 truncate text-content/40">{parts.join(" · ")}</span> : null}
        </div>
        <div className="h-px min-w-4 flex-1 bg-content/10" />
      </div>
    </div>
  );
}

const ESTIMATE_MS = 20_000;

function ActiveCompaction({ startedAt, trigger }: { startedAt?: number; trigger?: string }) {
  const reduce = useReducedMotion();
  const now = useClock(true);
  const elapsed = startedAt && now ? Math.max(0, now - startedAt) : 0;
  const pct = Math.min(90, 100 * (1 - Math.exp(-elapsed / ESTIMATE_MS)));
  return (
    <div
      role="status"
      aria-label="Compacting context"
      className="flex items-center gap-2 py-3 font-sans text-[12px] text-content/50"
    >
      <motion.span
        className="size-1.5 shrink-0 rounded-full bg-violet"
        animate={reduce ? undefined : { opacity: [1, 0.35, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: EASE_IN_OUT }}
      />
      <span className="shrink-0 text-content/70">Compacting context</span>
      {trigger ? <span className="min-w-0 truncate text-content/40">{trigger}</span> : null}
      <span className="h-0.5 w-16 shrink-0 overflow-hidden rounded-full bg-content/10">
        <span
          className="block h-full w-full origin-left rounded-full bg-violet/70 transition-transform duration-1000 ease-linear"
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </span>
      {startedAt ? <span className="ml-auto shrink-0 tabular-nums text-content/40">{formatDuration(elapsed)}</span> : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
