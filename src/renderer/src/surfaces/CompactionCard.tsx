import { FoldVertical } from "../chrome/icons";
import { Spinner } from "../components/ui/spinner";
import { StatusMark } from "../components/ui/status";
import { TextShimmer } from "../components/ui/text-shimmer";
import type { Block } from "../lib/session";
import { formatTokens } from "../lib/contextUsage";
import { useClock } from "../lib/turnClock";
import { spanWords } from "./transcript/thinking";
import { NoticeLine } from "./transcript/NoticeLine";

/**
 * A compaction on one notice line: "Compacting context" shimmering with the
 * time so far while the harness squeezes the window, "Context compacted"
 * with the before and after once it lands, "Compaction failed" with the
 * error when it does not.
 */
export function CompactionCard({ block }: { block: Block }) {
  const meta = block.compaction;
  if (!meta) return null;
  if (meta.phase === "start") return <ActiveCompaction startedAt={meta.startedAt} />;
  if (meta.phase === "failed") {
    return (
      <NoticeLine
        data-state="failed"
        glyph={<StatusMark state="failed" word={false} />}
        lead="Compaction failed"
        tone="strong"
        details={[meta.error]}
      />
    );
  }
  const tokens =
    meta.preTokens !== undefined && meta.postTokens !== undefined
      ? `${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)}`
      : meta.postTokens !== undefined
        ? `now ${formatTokens(meta.postTokens)}`
        : undefined;
  return (
    <NoticeLine
      glyph={<FoldVertical />}
      lead="Context compacted"
      details={[tokens, meta.durationMs !== undefined ? spanWords(meta.durationMs) : undefined]}
    />
  );
}

function ActiveCompaction({ startedAt }: { startedAt?: number }) {
  const now = useClock(true);
  const elapsed = startedAt && now ? Math.max(0, now - startedAt) : undefined;
  return (
    <NoticeLine
      role="status"
      aria-label="Compacting context"
      glyph={<Spinner />}
      lead={<TextShimmer>Compacting context</TextShimmer>}
      details={[elapsed !== undefined ? <span className="tabular-nums">{spanWords(elapsed)}</span> : undefined]}
    />
  );
}
