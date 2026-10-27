import type { AccountHeadroom } from "@server/shared/accounts";
import { Progress, type ProgressFill } from "../components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { headroomLook, type HeadroomLook } from "../lib/headroom";

const FILL: Record<HeadroomLook["tone"], ProgressFill> = {
  muted: "muted",
  ok: "muted",
  low: "warning",
  limited: "warning",
};
const TEXT: Record<HeadroomLook["tone"], string> = {
  muted: "text-muted-foreground/50",
  ok: "text-muted-foreground",
  low: "text-warning",
  limited: "text-warning",
};

/**
 * The gateway's view of one account's per-request limits: a short bar of
 * what is left, the word beside it, and the reset moment on hover. Nothing
 * moves but the bar's fill when the snapshot changes.
 */
export function HeadroomLine({ headroom, now, className }: { headroom: AccountHeadroom | undefined; now: number; className?: string }) {
  const look = headroomLook(headroom, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("flex items-center gap-2 text-[12px] leading-none", className)} data-headroom={look.tone} />}
      >
        <span className="shrink-0 text-muted-foreground">Headroom</span>
        <Progress
          value={look.percent}
          fill={FILL[look.tone]}
          aria-label={`Headroom: ${look.until ? `${look.text} for ${look.until}` : look.text}`}
          className="w-12 shrink-0"
        />
        <span className={cn("flex min-w-0 gap-2 tabular-nums", TEXT[look.tone])}>
          <span className="truncate">{look.text}</span>
          {look.until ? <span className="shrink-0">{look.until}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {look.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
