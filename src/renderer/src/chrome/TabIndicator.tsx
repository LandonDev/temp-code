import type { BackgroundWork } from "@shared/events";
import { StatusMark } from "../components/ui/status";
import type { ActivityKind } from "../lib/session";
import type { SessionStatus } from "../lib/tcserver/types";
import { marksAtRest, threadStatus, type ThreadStatus } from "../lib/threadStripModel";

/** What a tab's focused thread is up to, computed in App from the session. */
export type TabThread = {
  type: string | null;
  status: SessionStatus;
  unread?: boolean;
  /** when this working stretch began (its first message) */
  since: number;
  activity?: string | null;
  activityKind?: ActivityKind | null;
  /** implementation threads: this round's task tally */
  tasks?: { done: number; total: number } | null;
  /** planning threads: plan written, awaiting a build */
  planReady?: boolean;
  /** paused active time, excluding the paused span */
  frozenElapsed?: number | null;
  /** failed: the host's one-line verdict, when it has one */
  failure?: string | null;
  /** waiting: the pending approval's label, what the thread waits on ("Bash: bun test") */
  waitingOn?: string | null;
  /** waiting: an undecided question in the transcript */
  asking?: boolean;
  /** what a watching thread waits on */
  background?: BackgroundWork | null;
  /** background tasks and live subagents the thread waits on, counted */
  backgroundWork?: number;
};

/**
 * The tab edge: the status glyph alone, and nothing for a thread at rest
 * (idle, done). No clock, no verb, no tally: the hover line and the strip
 * above the composer say those, so a working tab never re-renders on a tick.
 */
export function TabIndicator({ thread }: { thread: TabThread }) {
  const { state } = threadStatus(thread);
  return marksAtRest(state) ? <StatusMark state={state} word={false} /> : null;
}

/**
 * A thread's status as one line: the mark with its word, what the state is
 * about, and the round's tally 8px after it. The strip, the chip's hover
 * line and the banners draw this; the tones are StatusMark's alone.
 */
export function ThreadStatusMark({
  status,
  word = true,
  className,
}: {
  status: ThreadStatus;
  word?: boolean;
  className?: string;
}) {
  const { detail, tally } = status;
  return (
    <StatusMark
      state={status.state}
      word={word}
      className={className}
      detail={
        detail || tally ? (
          <>
            {detail}
            {tally ? <span className={detail ? "ms-2" : undefined}>{tally}</span> : null}
          </>
        ) : null
      }
    />
  );
}
