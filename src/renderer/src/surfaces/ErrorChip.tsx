import type { ErrorRow } from "../lib/turnOutcome";
import { StatusMark } from "../components/ui/status";
import { NoticeLine } from "./transcript/NoticeLine";
import { FailureCard } from "./FailureCard";

/**
 * The row a turn ends on when it did not finish: a quiet Stopped line for
 * the user's own Stop, and the failure card (FailureCard.tsx) for every
 * failure, naming what happened with the actions that fit. A row the host
 * never classified reads the shared fallback (src/shared/failureFallback.ts);
 * Retry shows only where the host can continue the work. The harness's raw
 * words never reach the transcript.
 */
export function ErrorChip({
  sessionId,
  row,
  busy,
}: {
  sessionId: string;
  row: ErrorRow;
  busy?: boolean;
}) {
  if (row.stopped) {
    return <NoticeLine role="status" glyph={<StatusMark state="stopped" word={false} />} lead="Stopped" />;
  }
  return <FailureCard sessionId={sessionId} failure={row.failure} canRetry={row.canRetry} busy={busy} />;
}
