import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useDocumentVisible, usePaneVisible } from "@renderer/hooks/paneVisibility";
import { cn } from "@renderer/lib/cn";

/** The one "something is happening" text: muted words, still for
 *  `--delay-pulse`, then opacity 1→0.75→1 over `--dur-pulse` on
 *  `--ease-breathe`, repeating (`text-pulse` in components.css). Still under
 *  reduced motion, in a hidden pane and while the document is hidden, so
 *  the loop never runs where nobody sees it. */
export function TextPulse({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const pane = usePaneVisible();
  const page = useDocumentVisible();
  return (
    <span data-slot="text-pulse" className={cn("text-muted-foreground", !reduce && pane && page && "text-pulse", className)}>
      {children}
    </span>
  );
}
