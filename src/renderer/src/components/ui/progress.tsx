import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@renderer/lib/cn";

export type ProgressFill = "foreground" | "muted" | "warning";

const FILL_CLASS: Record<ProgressFill, string> = {
  foreground: "bg-primary",
  muted: "bg-muted-foreground",
  warning: "bg-warning",
};

/** A 4px determinate bar. The usage meter and task tallies build on it.
 *  `fill` tints the bar (muted for room that is not news, warning when it
 *  runs low); the fill is a transform, so a live update never relayouts. */
function Progress({ className, children, value, max = 100, fill = "foreground", ...props }: ProgressPrimitive.Root.Props & { fill?: ProgressFill }) {
  const fraction = value == null ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <ProgressPrimitive.Root value={value} max={max} data-slot="progress" data-fill={fill} className={cn("flex flex-wrap gap-2", className)} {...props}>
      {children}
      <ProgressTrack>
        <ProgressIndicator className={FILL_CLASS[fill]} style={{ width: "100%", transform: `scaleX(${fraction})` }} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return <ProgressPrimitive.Track className={cn("relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted", className)} data-slot="progress-track" {...props} />;
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
  return <ProgressPrimitive.Indicator data-slot="progress-indicator" className={cn("h-full origin-left rounded-full bg-primary transition-transform duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none", className)} {...props} />;
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return <ProgressPrimitive.Label className={cn("text-[13px] font-medium", className)} data-slot="progress-label" {...props} />;
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return <ProgressPrimitive.Value className={cn("ms-auto text-xs text-muted-foreground tabular-nums", className)} data-slot="progress-value" {...props} />;
}

export { Progress, ProgressTrack, ProgressIndicator, ProgressLabel, ProgressValue };
