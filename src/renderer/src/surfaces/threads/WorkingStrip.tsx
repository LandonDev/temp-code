import { memo, useEffect, useState, type ReactNode } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
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
import { COLUMN_MAX_CLASS } from "../transcriptOutlineModel";
import { DUR } from "../../lib/ease";

/** What the row draws; the slot keeps the last of these for its exit fade. */
type RowView = { slot: NonNullable<ReturnType<typeof composerSlotOf>>; state: string; status: ReturnType<typeof threadStatus>; elapsed: number; batchPaused: number };

function sameView(a: RowView | null, b: RowView): boolean {
  return (
    !!a &&
    a.slot === b.slot &&
    a.state === b.state &&
    a.status.state === b.status.state &&
    a.status.detail === b.status.detail &&
    a.status.tally === b.status.tally &&
    a.elapsed === b.elapsed &&
    a.batchPaused === b.batchPaused
  );
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
  // A busy session whose row has not caught up still works, a send just
  // made over a failure or a stop included (its click stamped sentAt).
  const status =
    session.busy &&
    (raw === "idle" || raw === "done" || ((raw === "error" || raw === "stopped") && session.sentAt != null))
      ? "running"
      : raw;
  const shownStatus = threadStatus({
    status,
    // A paused subagent pauses the root's row, as on its chip; Continue resumes the tree.
    // A subagent carries its root's flags too, and keeps its own row.
    treeHasPaused: !session.parentId && session.treeHasPaused,
    treeCanContinue: !session.parentId && session.treeCanContinue,
    activity: session.activity,
    statusDetail: session.statusDetail,
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

  // When the slot empties, the outgoing row stays for --dur-fast and fades
  // (inert, so nothing in it takes a click on its way out); under reduced
  // motion it goes at once. The reserved 28px never changes.
  const live: RowView | null = slot ? { slot, state, status: shownStatus, elapsed, batchPaused } : null;
  const [last, setLast] = useState<RowView | null>(live);
  const [leaving, setLeaving] = useState<RowView | null>(null);
  if (live) {
    if (!sameView(last, live)) setLast(live);
    if (leaving) setLeaving(null);
  } else if (last) {
    setLast(null);
    if (!reducedMotion()) setLeaving(last);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), DUR.fast * 1000);
    return () => clearTimeout(timer);
  }, [leaving]);
  const view = live ?? leaving;

  const time = (ms: number, role?: "timer") => (
    <span role={role} className="shrink-0 tabular-nums text-muted-foreground">
      {duration(ms)}
    </span>
  );
  const row = ((): ReactNode => {
    if (!view) return null;
    const { slot, state, status: shownStatus, elapsed, batchPaused } = view;
    if (slot === "timer") {
      return (
        <>
          {elapsed >= 1000 ? time(elapsed, "timer") : null}
          <Actions>
            <Button variant="ghost" size="xs" onClick={stopTurn} disabled={stopping}>
              <BusyLabel busy={stopping} label="Stop" busyLabel="Stopping…" />
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
                <BusyLabel busy={resumeBusy} label="Continue" busyLabel="Continuing…" />
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
                <BusyLabel busy={resumeBusy} label="Resume" busyLabel="Resuming…" />
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
                <Button variant="secondary" size="xs" onClick={start} disabled={startBusy}>
                  <BusyLabel busy={startBusy} label="Start now" busyLabel="Starting…" />
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
    <div className={cn("mx-auto h-7 w-full shrink-0", COLUMN_MAX_CLASS)}>
      {/* A screen reader hears the state change, never the second hand. */}
      <span className="sr-only" aria-live="polite">
        {visible ? STATUS_WORD[state] : ""}
      </span>
      <div
        inert={!visible}
        data-leaving={!visible && leaving ? "" : undefined}
        className={cn(
          "flex h-full items-center gap-1 px-1.5 text-xs transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none",
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
