// A7 (turn structure): the one way a line or a row draws its counts.
import { StatusMark } from "../../components/ui/status";
import { cn } from "../../lib/cn";

/**
 * `+46 −3` in green and red and the failed mark with its count, tabular, at
 * the text's size (13px in a row and on the group line). Zero draws nothing;
 * with nothing to say the component is null. A caller that ticks the
 * numbers (useCountUp) passes the ticked values; one outside the transcript
 * sets its own size with `className`.
 */
export function Counts({
  added = 0,
  removed = 0,
  failed = 0,
  className,
}: {
  added?: number;
  removed?: number;
  failed?: number;
  className?: string;
}) {
  if (!added && !removed && !failed) return null;
  return (
    <span data-slot="counts" className={cn("flex shrink-0 items-center gap-1 tabular-nums", className)}>
      {added ? <span className="text-success">+{added}</span> : null}
      {removed ? <span className="text-destructive">−{removed}</span> : null}
      {failed ? (
        <StatusMark state="failed" word={String(failed)} aria-label={`${failed} failed`} className="gap-1 text-[length:inherit] font-normal" />
      ) : null}
    </span>
  );
}
