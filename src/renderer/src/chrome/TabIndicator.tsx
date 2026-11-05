import { StatusMark } from "../components/ui/status";
import type { ThreadStatus } from "../lib/threadStripModel";

/**
 * A thread's status as one line: the mark with its word, what the state is
 * about, and the round's tally 4px after it. The strip, the chip's hover
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
            {tally ? <span className={detail ? "ms-1" : undefined}>{tally}</span> : null}
          </>
        ) : null
      }
    />
  );
}
