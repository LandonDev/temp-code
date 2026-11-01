import { memo, useState, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { STATUS_WORD } from "@renderer/components/ui/status";
import { cn } from "@renderer/lib/cn";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { ThreadStatusMark } from "../../chrome/TabIndicator";
import type { Session } from "../../lib/session";
import { composerSlotOf, threadStatus } from "../../lib/threadStripModel";
import { turnElapsed, useClock } from "../../lib/turnClock";
import { isMasterThread } from "../../lib/masterThread";
import { useSessionMetasWhen } from "../../lib/tcserver/store";
import { duration } from "../../lib/duration";

/**
 * The slot above the composer, permanently reserved at 28px so neither the
 * composer nor the transcript moves when a turn starts or ends
 * (`composerSlotOf`). While a turn is open (working, starting, waiting on the
 * person) it holds the stretch's elapsed time and Stop, nothing else: what
 * the thread does is the transcript's working line, and an approval or a
 * question is its card. A held thread keeps one quiet row with its word and
 * actions: paused with its frozen time, Stop and Continue (a master's says
 * "and 3 batch threads with it"), stopped (the harness behind the turn is
 * gone) with Resume, queued with the host's reason and Start now. Watching,
 * failed, done and idle leave the slot empty; a watching thread says so in
 * the transcript's closing line. Only opacity animates in and out (120ms).
 */
export const WorkingStrip = memo(function WorkingStrip({
  session,
  onStop,
  onResume,
  onStart,
}: {
  session: Session;
  onStop: () => void;
  onResume: () => Promise<void> | void;
  /** Start a queued thread now (session.start); absent, the row only says Queued. */
  onStart?: () => Promise<void> | void;
}) {
  const raw = session.status ?? (session.busy ? "running" : "idle");
  // A busy session whose row has not caught up still works.
  const status = session.busy && (raw === "idle" || raw === "done") ? "running" : raw;
  const shownStatus = threadStatus({
    status,
    // A paused subagent pauses the root's row, as on its chip; Continue resumes the tree.
    // A subagent carries its root's flags too, and keeps its own row.
    treeHasPaused: !session.parentId && session.treeHasPaused,
    treeCanContinue: !session.parentId && session.treeCanContinue,
    activity: session.activity,
    tasks: session.tasks,
    background: session.background,
  });
  const { state } = shownStatus;
  const slot = composerSlotOf(state);
  const visible = slot !== null;
  // A paused master pauses its batch: the row says how many threads hold with it.
  const batchPaused = useBatchPaused(session.id, state === "paused" && isMasterThread(session));

  const shown = usePaneVisible();
  // The shared second hand, only while the timer shows and the pane is on
  // screen; a parked pane reads 0 and catches up on its first visible tick.
  const now = useClock(slot === "timer" && shown);
  const elapsed =
    state === "paused" || state === "stopped"
      ? Math.max(0, session.frozenActiveElapsed ?? 0)
      : slot === "timer" && now > 0
        ? (turnElapsed({ ...session, status }, now) ?? 0)
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
  // Stop on the timer holds "Stopping…" until the row leaves the timer.
  const [stopping, setStopping] = useState(false);
  const [stoppingSlot, setStoppingSlot] = useState(slot);
  if (stoppingSlot !== slot) {
    setStoppingSlot(slot);
    if (stopping) setStopping(false);
  }
  const stopTurn = (): void => {
    if (stopping) return;
    setStopping(true);
    onStop();
  };

  const time = (ms: number, role?: "timer") => (
    <span role={role} className="shrink-0 tabular-nums text-muted-foreground">
      {duration(ms)}
    </span>
  );
  const row = ((): ReactNode => {
    if (slot === "timer") {
      return (
        <>
          {elapsed >= 1000 ? time(elapsed, "timer") : null}
          <Actions>
            <Button variant="ghost" size="xs" onClick={stopTurn} disabled={stopping}>
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          </Actions>
        </>
      );
    }
    const mark = <ThreadStatusMark status={shownStatus} />;
    switch (state) {
      case "paused":
        return (
          <>
            {batchPaused > 0 ? (
              <ThreadStatusMark status={{ ...shownStatus, detail: `and ${batchPaused} batch thread${batchPaused === 1 ? "" : "s"} with it` }} />
            ) : (
              mark
            )}
            {elapsed > 0 ? time(elapsed) : null}
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
      default:
        return null;
    }
  })();

  return (
    <div className="mx-auto h-7 w-full max-w-4xl shrink-0">
      {/* A screen reader hears the state change, never the second hand. */}
      <span className="sr-only" aria-live="polite">
        {visible ? STATUS_WORD[state] : ""}
      </span>
      <div
        className={cn(
          "flex h-full items-center gap-2 px-4 text-xs transition-opacity duration-(--dur-fast) ease-(--ease-out)",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        {row}
      </div>
    </div>
  );
});

/** How many of a master's batch threads are paused with it; the metas are
 *  read only while the master is paused. */
function useBatchPaused(masterId: string, on: boolean): number {
  const metas = useSessionMetasWhen(on);
  if (!on) return 0;
  return metas.filter((m) => m.masterId === masterId && !m.archived && !m.parentId && (m.status === "paused" || m.treeHasPaused)).length;
}

/** The row's actions, at its end. */
function Actions({ children }: { children: ReactNode }) {
  return <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>;
}
