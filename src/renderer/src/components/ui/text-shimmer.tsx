import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { usePaneVisible } from "@renderer/hooks/paneVisibility";
import { cn } from "@renderer/lib/cn";

/** The one "something is happening" text: a soft highlight sweeps through
 *  muted text (`.shimmer` in components.css, 2s, GPU-only). Reduced motion
 *  and a hidden pane show plain muted text. */
export function TextShimmer({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const shown = usePaneVisible();
  if (reduce || !shown) return <span className={cn("text-muted-foreground", className)}>{children}</span>;
  return <span className={cn("shimmer", className)}>{children}</span>;
}
