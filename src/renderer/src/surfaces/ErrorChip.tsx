import { useEffect, useState } from "react";
import { continueSession } from "../lib/tcserver/commands";
import type { ErrorRow } from "../lib/turnOutcome";
import { Button } from "../components/ui/button";
import { StatusMark } from "../components/ui/status";
import { NoticeLine } from "./transcript/NoticeLine";
import { FailureCard } from "./FailureCard";

/**
 * The row a turn ends on when it did not finish: a quiet Stopped line for
 * the user's own Stop; the failure card (FailureCard.tsx) when the host
 * classified the error, naming what happened and the account with the
 * actions that fit; and a Failed line with the harness's words for a row
 * written before the verdict existed. Continue shows on that last one
 * only, when the server says the tree can pick the work back up; it reads
 * "Continuing…" until the thread turns busy and the fold clears the row.
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
  const [continuing, setContinuing] = useState(false);
  useEffect(() => {
    if (busy) setContinuing(false);
  }, [busy]);

  if (!row.stopped && row.failure) {
    return <FailureCard sessionId={sessionId} failure={row.failure} busy={busy} />;
  }

  if (row.stopped) {
    return <NoticeLine role="status" glyph={<StatusMark state="stopped" word={false} />} lead="Stopped" />;
  }

  return (
    <NoticeLine
      role="alert"
      data-state="failed"
      glyph={<StatusMark state="failed" word={false} />}
      lead="Failed"
      tone="strong"
      wrap
      details={[row.message]}
    >
      {row.showContinue ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-1 mb-2"
          disabled={continuing}
          onClick={() => {
            setContinuing(true);
            void continueSession(sessionId).catch(() => setContinuing(false));
          }}
        >
          {continuing ? "Continuing…" : "Continue"}
        </Button>
      ) : null}
    </NoticeLine>
  );
}
