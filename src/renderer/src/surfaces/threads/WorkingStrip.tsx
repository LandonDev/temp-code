import { memo, useState, type ReactNode } from "react";
import { isStaleWatch } from "@server/shared/watch";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { ThreadStatusMark } from "../../chrome/TabIndicator";
import { stopAll } from "../../lib/activity";
import { pendingApprovalForSession } from "../../lib/approvalToast";
import type { ApprovalDecision } from "../../lib/harness";
import type { Session } from "../../lib/session";
import { hasPendingQuestion, threadStatus } from "../../lib/threadStripModel";
import { useClock, useSlowClock } from "../../lib/turnClock";
import { duration } from "../../lib/duration";

/**
 * The thread's status above the composer, in a permanently reserved 28px
 * slot: the composer never shifts when work starts or stops. Every state is
 * one row with no box or wash: the status mark (its word, what it is about,
 * the round's tally), a time where the state has one, and the actions at
 * the end. Working says what it does and the stretch's elapsed time; a
 * pending approval reads "Needs you  approve Bash" with Deny and Allow (the
 * transcript's card keeps its own); a question says so and leaves the choice
 * to its card; paused keeps its frozen time with Stop and Continue; stopped
 * (the harness behind the turn is gone) offers Resume; queued gives the
 * host's reason and Start now; watching says what it watches with the
 * stretch's age, amber with Stop all past 30 minutes, and opens the Activity
 * section. Failed, done and idle leave the slot empty. Only opacity animates
 * in and out (120ms).
 */

/** When the current working stretch began: server-stamped, else the last user turn. */
export function turnStartOf(session: Session): number | undefined {
  if (session.busySince) return session.busySince;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const b = session.blocks[i];
    if (b.role === "user") return b.ts ?? b.startedAt;
  }
  return undefined;
}

export const WorkingStrip = memo(function WorkingStrip({
  session,
  onStop,
  onResume,
  onStart,
  onApproval,
  onOpenActivity,
}: {
  session: Session;
  onStop: () => void;
  onResume: () => Promise<void> | void;
  /** Start a queued thread now (session.start); absent, the strip only says Queued. */
  onStart?: () => Promise<void> | void;
  /** Allow or Deny the pending approval; absent, the strip only says what it waits on. */
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  /** A watching line's click: the right panel's Activity section. */
  onOpenActivity?: () => void;
}) {
  const raw = session.status ?? (session.busy ? "running" : "idle");
  // A busy session whose row has not caught up still works.
  const status = session.busy && (raw === "idle" || raw === "done") ? "running" : raw;
  const approval = status === "waiting" ? pendingApprovalForSession(session) : null;
  const shownStatus = threadStatus({
    status,
    activity: session.activity,
    tasks: session.tasks,
    waitingOn: approval?.label ?? null,
    asking: status === "waiting" && hasPendingQuestion(session.blocks),
    background: session.background,
  });
  const { state } = shownStatus;
  const active = state === "working";
  const frozen = state === "paused" || state === "stopped";
  const visible = active || frozen || state === "waiting" || state === "queued" || state === "watching";

  const shown = usePaneVisible();
  // The shared second hand, only while the strip works and is on screen; a
  // parked pane reads 0 and catches up on its first visible tick.
  const now = useClock(active && shown);
  // The watching age moves by minutes: the half-minute clock, only while watching.
  const slowNow = useSlowClock(state === "watching" && shown);
  const turnStart = turnStartOf(session);
  const elapsed = frozen
    ? Math.max(0, session.frozenActiveElapsed ?? 0)
    : active && now > 0
      ? Math.max(0, now - (turnStart ?? now))
      : 0;

  const [resumeBusy, setResumeBusy] = useState(false);
  const resume = (): void => {
    if (resumeBusy) return;
    setResumeBusy(true);
    Promise.resolve(onResume()).finally(() => setResumeBusy(false));
  };
  const [startBusy, setStartBusy] = useState(false);
  const start = (): void => {
    if (startBusy || !onStart) return;
    setStartBusy(true);
    Promise.resolve(onStart()).finally(() => setStartBusy(false));
  };
  const [stopBusy, setStopBusy] = useState(false);
  const stopEverything = (): void => {
    if (stopBusy) return;
    setStopBusy(true);
    stopAll(session.id).finally(() => setStopBusy(false));
  };
  const watchSince = session.background?.watchingSince ?? null;
  const stale = state === "watching" && slowNow > 0 && isStaleWatch({ status, background: session.background }, slowNow);

  const time = (ms: number, className?: string) => (
    <span className={cn("shrink-0 tabular-nums text-muted-foreground", className)}>{duration(ms)}</span>
  );
  const row = ((): ReactNode => {
    if (!visible) return null;
    const mark = <ThreadStatusMark status={shownStatus} />;
    switch (state) {
      case "working":
        return (
          <>
            {mark}
            {elapsed >= 1000 ? time(elapsed) : null}
          </>
        );
      case "waiting":
        return (
          <>
            {mark}
            {approval && onApproval ? (
              <Actions>
                <Button variant="ghost" size="xs" onClick={() => onApproval(approval.requestId, "deny")}>
                  Deny
                </Button>
                <Button variant="secondary" size="xs" onClick={() => onApproval(approval.requestId, "allow")}>
                  Allow
                </Button>
              </Actions>
            ) : null}
          </>
        );
      case "paused":
        return (
          <>
            {mark}
            {time(elapsed)}
            <Actions>
              <Button variant="ghost" size="xs" onClick={onStop}>
                Stop
              </Button>
              <Button variant="secondary" size="xs" onClick={resume} disabled={resumeBusy}>
                {resumeBusy ? "Continuing…" : "Continue"}
              </Button>
            </Actions>
          </>
        );
      case "stopped":
        return (
          <>
            {mark}
            {elapsed > 0 ? time(elapsed) : null}
            <Actions>
              <Button variant="secondary" size="xs" onClick={resume} disabled={resumeBusy}>
                {resumeBusy ? "Resuming…" : "Resume"}
              </Button>
            </Actions>
          </>
        );
      case "queued":
        return (
          <>
            {mark}
            {onStart ? (
              <Actions>
                <Button variant="ghost" size="xs" onClick={start} disabled={startBusy}>
                  {startBusy ? "Starting…" : "Start now"}
                </Button>
              </Actions>
            ) : null}
          </>
        );
      case "watching":
        return (
          <>
            <WatchLine onOpen={onOpenActivity}>{mark}</WatchLine>
            {watchSince && slowNow > 0 ? time(Math.max(0, slowNow - watchSince), cn("ml-auto", stale && "text-warning")) : null}
            {stale ? (
              <Button variant="ghost" size="xs" className="shrink-0" onClick={stopEverything} disabled={stopBusy}>
                {stopBusy ? "Stopping…" : "Stop all"}
              </Button>
            ) : null}
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="mx-auto h-7 w-full max-w-4xl shrink-0">
      <div
        className={cn(
          "flex h-full items-center gap-2 px-4 text-xs transition-opacity duration-(--dur-fast) ease-(--ease-out)",
          visible ? "opacity-100" : "opacity-0",
        )}
        aria-live="polite"
      >
        {row}
      </div>
    </div>
  );
});

/** The row's actions, at its end. */
function Actions({ children }: { children: ReactNode }) {
  return <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>;
}

/** The watching line: a button onto the Activity section when there is one to open. */
function WatchLine({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) {
  const row = "flex min-w-0 items-center";
  if (!onOpen) return <span className={row}>{children}</span>;
  return (
    <Button variant="ghost" size="xs" onClick={onOpen} className={cn(row, "-ml-2 shrink justify-start")}>
      {children}
    </Button>
  );
}
