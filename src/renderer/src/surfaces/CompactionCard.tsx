import type { ReactNode } from "react";
import { COMPACTING_WORDS } from "@shared/statusWords";
import { FoldVertical } from "../chrome/icons";
import { StatusMark } from "../components/ui/status";
import { WorkingText } from "../components/ui/working-text";
import type { Block } from "../lib/session";
import { formatTokens } from "../lib/contextUsage";
import { useClock } from "../lib/turnClock";
import { usePaneVisible } from "../hooks/paneVisibility";
import { spanWords } from "./transcript/thinking";
import { NoticeLine } from "./transcript/NoticeLine";
import { SwapIcon } from "../motion/IconSwap";
import { MorphText } from "../motion/MorphText";
import { cn } from "../lib/cn";

/**
 * A compaction on one notice line: "Compacting context" pulsing with the
 * time since its start while the harness squeezes the window, "Context
 * compacted" with the before and after once it lands, "Compaction failed"
 * with the error when it does not, and "Compaction stopped" with its span
 * when its turn ended with neither. One line for its whole life: the glyph
 * swaps in place (SwapIcon) and the words with their details morph
 * (MorphText), so the outcome never remounts the row; the clock ticks in a
 * child of its own.
 */
export function CompactionCard({ block }: { block: Block }) {
  const meta = block.compaction;
  if (!meta) return null;
  const { phase } = meta;
  const failed = phase === "failed";
  const details = outcomeDetails(meta);
  return (
    <NoticeLine
      data-state={phase === "start" || phase === "done" ? undefined : phase}
      role={phase === "start" ? "status" : undefined}
      aria-label={phase === "start" ? COMPACTING_WORDS : undefined}
      glyph={<SwapIcon state={phase}>{GLYPH[phase]}</SwapIcon>}
      tone={failed ? "strong" : "muted"}
      wrap={failed}
      lead={
        <MorphText state={phase} className="min-w-0">
          <span className="flex min-w-0 items-center gap-1">
            {phase === "start" ? (
              <WorkingText className={cn(meta.startedAt && "font-medium")}>{COMPACTING_WORDS}</WorkingText>
            ) : (
              <span className={cn("shrink-0", details.length > 0 && "font-medium")}>{LEAD[phase]}</span>
            )}
            {phase === "start" ? <CompactionClock startedAt={meta.startedAt} /> : null}
            {details.length > 0 ? <Details items={details} /> : null}
          </span>
        </MorphText>
      }
      details={failed ? [meta.error] : undefined}
    />
  );
}

type Phase = NonNullable<Block["compaction"]>["phase"];

const GLYPH: Record<Phase, ReactNode> = {
  start: <StatusMark state="working" word={false} still />,
  done: <FoldVertical className="size-3.5" />,
  failed: <StatusMark state="failed" word={false} />,
  stopped: <StatusMark state="stopped" word={false} />,
};

const LEAD: Record<Phase, string> = {
  start: COMPACTING_WORDS,
  done: "Context compacted",
  failed: "Compaction failed",
  stopped: "Compaction stopped",
};

/** What an outcome adds after its lead: the before and after and the span for "done", the span for "stopped". */
function outcomeDetails(meta: NonNullable<Block["compaction"]>): string[] {
  if (meta.phase === "stopped") {
    return meta.startedAt !== undefined && meta.endedAt !== undefined ? [spanWords(meta.endedAt - meta.startedAt)] : [];
  }
  if (meta.phase !== "done") return [];
  const tokens =
    meta.preTokens !== undefined && meta.postTokens !== undefined
      ? `${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)}`
      : meta.postTokens !== undefined
        ? `now ${formatTokens(meta.postTokens)}`
        : undefined;
  return [tokens, meta.durationMs !== undefined ? spanWords(meta.durationMs) : undefined].filter((d): d is string => !!d);
}

/** The details as one muted comma run that truncates once, as a notice's are. */
function Details({ items }: { items: string[] }) {
  return (
    <span data-slot="notice-details" className="min-w-0 truncate text-muted-foreground tabular-nums">
      {items.join(", ")}
    </span>
  );
}

/** The time since the compaction started; a hidden pane does not tick. */
function CompactionClock({ startedAt }: { startedAt?: number }) {
  const now = useClock(usePaneVisible());
  if (!startedAt || !now) return null;
  return <span className="tabular-nums text-muted-foreground">{spanWords(Math.max(0, now - startedAt))}</span>;
}
