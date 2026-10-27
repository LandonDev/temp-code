// A7 (turn structure): the one way a line or a row draws its counts.
import { StatusMark } from "../../components/ui/status";

/**
 * `+46 −3` in green and red and the failed mark with its count, tabular, at
 * 13px. Zero draws nothing; with nothing to say the component is null. A
 * caller that ticks the numbers (useCountUp) passes the ticked values.
 */
export function Counts({ added = 0, removed = 0, failed = 0 }: { added?: number; removed?: number; failed?: number }) {
  if (!added && !removed && !failed) return null;
  return (
    <span data-slot="counts" className="flex shrink-0 items-center gap-1 text-[13px] tabular-nums">
      {added ? <span className="text-success">+{added}</span> : null}
      {removed ? <span className="text-destructive">−{removed}</span> : null}
      {failed ? (
        <StatusMark
          state="failed"
          word={String(failed)}
          aria-label={`${failed} failed`}
          className="text-[13px] font-normal"
        />
      ) : null}
    </span>
  );
}
