import { useEffect, useState } from "react";
import { continueSession } from "../lib/tcserver/commands";
import type { ErrorRow } from "../lib/turnOutcome";
import { AlertCircle, StopCircle } from "../chrome/icons";

/**
 * The row a turn ends on when it did not finish: a quiet gray Stopped for
 * the user's own Stop, red Failed with the harness's words for anything
 * else. Continue shows on one Failed row only, when the server says the
 * tree can pick the work back up; it reads "Continuing…" until the thread
 * turns busy and the fold clears the row.
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

  if (row.stopped) {
    return (
      <div
        role="status"
        className="flex min-h-[34px] items-center gap-2 px-4 py-2 font-sans text-[12px] text-content/45"
      >
        <StopCircle className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span>Stopped</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex min-h-[34px] min-w-0 items-start gap-2 px-4 py-2 font-sans text-[12px] text-red-500"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 break-words">
          <span className="font-medium">Failed</span>
          {row.message ? <span className="text-red-500/80"> · {row.message}</span> : null}
        </span>
        {row.showContinue ? (
          <span>
            <button
              type="button"
              disabled={continuing}
              className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20 disabled:opacity-40"
              onClick={() => {
                setContinuing(true);
                void continueSession(sessionId).catch(() => setContinuing(false));
              }}
            >
              {continuing ? "Continuing…" : "Continue"}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
