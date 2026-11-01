import { COMPACTING_WORDS } from "@shared/statusWords";
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
 * time since its start while the harness squeezes the window, "Context
 * compacted" with the before and after once it lands, "Compaction failed"
 * with the error when it does not, and "Compaction stopped" with its span
 * when its turn ended with neither.
 */
export function CompactionCard({ block }: { block: Block }) {
  const meta = block.compaction;
  if (!meta) return null;
  if (meta.phase === "start") return <ActiveCompaction startedAt={meta.startedAt} />;
  if (meta.phase === "stopped") {
    const span = meta.startedAt !== undefined && meta.endedAt !== undefined ? spanWords(meta.endedAt - meta.startedAt) : undefined;
    return (
      <NoticeLine
        data-state="stopped"
        glyph={<StatusMark state="stopped" word={false} />}
        lead="Compaction stopped"
        details={[span ? <span className="tabular-nums">{span}</span> : undefined]}
      />
    );
  }
  if (meta.phase === "failed") {
    return (
      <NoticeLine
        data-state="failed"
        glyph={<StatusMark state="failed" word={false} />}
        lead="Compaction failed"
        tone="strong"
        wrap
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
      aria-label={COMPACTING_WORDS}
      glyph={<Spinner />}
      lead={<TextShimmer>{COMPACTING_WORDS}</TextShimmer>}
      details={[elapsed !== undefined ? <span className="tabular-nums">{spanWords(elapsed)}</span> : undefined]}
    />
  );
}
