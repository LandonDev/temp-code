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
            {phase === "start" ? <WorkingText>{COMPACTING_WORDS}</WorkingText> : <span className="shrink-0">{LEAD[phase]}</span>}
            {phase === "start" ? <CompactionClock startedAt={meta.startedAt} /> : null}
            {phase === "done" ? <Details items={doneDetails(meta)} /> : null}
            {phase === "stopped" && meta.startedAt !== undefined && meta.endedAt !== undefined ? (
              <span className="tabular-nums text-muted-foreground">{spanWords(meta.endedAt - meta.startedAt)}</span>
            ) : null}
          </span>
        </MorphText>
      }
      details={failed ? [meta.error] : undefined}
    />
  );
}

type Phase = NonNullable<Block["compaction"]>["phase"];

const GLYPH: Record<Phase, ReactNode> = {
  // The transcript's one moving mark is the working line's; a running row draws working as the dot.
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

function doneDetails(meta: NonNullable<Block["compaction"]>): string[] {
  const tokens =
    meta.preTokens !== undefined && meta.postTokens !== undefined
      ? `${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)}`
      : meta.postTokens !== undefined
        ? `now ${formatTokens(meta.postTokens)}`
        : undefined;
  return [tokens, meta.durationMs !== undefined ? spanWords(meta.durationMs) : undefined].filter((d): d is string => !!d);
}

function Details({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <span key={item} className="min-w-0 truncate text-muted-foreground tabular-nums">
          {item}
        </span>
      ))}
    </>
  );
}

/** The time since the compaction started; a hidden pane does not tick. */
function CompactionClock({ startedAt }: { startedAt?: number }) {
  const now = useClock(usePaneVisible());
  if (!startedAt || !now) return null;
  return <span className="tabular-nums text-muted-foreground">{spanWords(Math.max(0, now - startedAt))}</span>;
}
