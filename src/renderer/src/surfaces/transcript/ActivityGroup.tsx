// A7 (turn structure): the non-zen activity group, retired by the action group.
import { ChevronRight } from "../../chrome/icons";
import { useLayoutEffect, useState } from "react";
import type { ApprovalDecision } from "../../lib/harness";
import { TWEEN_FALLBACK_MS, TweenHeight } from "../../motion/TweenHeight";
import { usePersistedOpen } from "../editOpenState";
import { useReducedMotion } from "motion/react";
import { type Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { useTranscriptSession } from "../transcriptSession";
import { activityPreviousLabel, splitActivityRows } from "../transcriptActivity";
import { ACTIVITY_ROW_HEIGHT, ActivityRow, DISCLOSURE_ROW } from "./ActivityRow";

/**
 * The default transcript's tool stack: the call the agent is on holds the
 * line, and everything it has already finished waits behind a disclosure.
 */
export function ActivityGroup({
  blocks,
  cwd,
  autoOpen = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  /** The group the agent is in: it opens by itself once a second call lands. */
  autoOpen?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession();
  const [override, setOverride] = usePersistedOpen(
    `${sessionId ?? "-"}:g:${blocks[0]?.id}`,
  );
  const { latest, pending, hidden } = splitActivityRows(blocks);
  const showPrevious = override ?? (autoOpen && hidden.length > 0);
  const reduceMotion = useReducedMotion() === true;
  // The fold tweens over rows that exist: mount them a frame before opening
  // and keep them through the close.
  const [mounted, setMounted] = useState(showPrevious);
  useLayoutEffect(() => {
    if (showPrevious) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), TWEEN_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [showPrevious]);

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {hidden.length > 0 ? (
        <button
          type="button"
          aria-expanded={showPrevious}
          aria-label={
            showPrevious
              ? "Hide previous tool calls"
              : `Show ${hidden.length} previous tool calls`
          }
          onClick={() => setOverride(!showPrevious)}
          className={`${DISCLOSURE_ROW} ${ACTIVITY_ROW_HEIGHT} shrink-0 text-content/40 transition-colors hover:text-content/70`}
        >
          <ChevronRight
            className={`size-3.5 shrink-0 transition-transform duration-150 ${
              showPrevious ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
          />
          <span>
            {showPrevious
              ? "Hide previous"
              : activityPreviousLabel(hidden.length)}
          </span>
        </button>
      ) : null}
      {mounted && hidden.length > 0 ? (
        <TweenHeight
          open={showPrevious && mounted}
          animate={!reduceMotion}
          className="flex flex-col gap-0.5"
        >
          {hidden.map((block) => (
            <ActivityRow
              key={block.id}
              block={block}
              cwd={cwd}
              expanded
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </TweenHeight>
      ) : null}
      {latest ? (
        <ActivityRow
          block={latest}
          cwd={cwd}
          live
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ) : null}
      {pending.map((block) => (
        <ActivityRow
          key={block.id}
          block={block}
          cwd={cwd}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}
