import type { AccountHeadroom } from "@server/shared/accounts";
import { headroomLook } from "../lib/headroom";

const FILL: Record<ReturnType<typeof headroomLook>["tone"], string> = {
  muted: "bg-content/25",
  ok: "bg-content/55",
  low: "bg-warning",
  limited: "bg-destructive",
};
const TEXT: Record<ReturnType<typeof headroomLook>["tone"], string> = {
  muted: "text-content/40",
  ok: "text-content/50",
  low: "text-warning",
  limited: "text-destructive",
};

/**
 * The gateway's view of one account's per-request limits: a short bar of
 * what is left, the word beside it, and the reset moment on hover. Nothing
 * moves: the bar is a reading, redrawn when the snapshot changes.
 */
export function HeadroomLine({ headroom, now, className = "" }: { headroom: AccountHeadroom | undefined; now: number; className?: string }) {
  const look = headroomLook(headroom, now);
  return (
    <span
      className={`flex items-center gap-1.5 text-[11px] leading-none ${className}`}
      title={look.title}
      data-headroom={look.tone}
    >
      <span className="shrink-0 text-content/40">Headroom</span>
      <span
        role="progressbar"
        aria-valuenow={look.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Headroom: ${look.text}`}
        className="relative block h-1 w-12 shrink-0 overflow-hidden rounded-full bg-content/10"
      >
        <span className={`block h-full rounded-full ${FILL[look.tone]}`} style={{ width: `${look.percent}%` }} />
      </span>
      <span className={`truncate tabular-nums ${TEXT[look.tone]}`}>{look.text}</span>
    </span>
  );
}
