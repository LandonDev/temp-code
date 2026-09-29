import { useLayoutEffect, useState, type ReactNode } from "react";
import { perfMark } from "../lib/perfMarks";

/**
 * Mounts `children` one frame after the first commit, so the chrome
 * around it paints with the click that opened it. `fallback` holds the
 * space meanwhile. Key it on what the children show, so a swap defers
 * again.
 *
 * The flip is plain state set from a requestAnimationFrame, not a
 * transition: a transition-lane render is interrupted and restarted by
 * every synchronous store notification (each session push, each per-frame
 * event flush), and React lets it starve for up to five seconds before
 * forcing it through. A sync render one frame later is not interruptible,
 * so a busy fleet cannot hold the transcript back.
 */
export function DeferredMount({
  children,
  fallback = null,
  markId,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  /** Session id stamped on the `tc:deferred-commit` mark. */
  markId?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    if (mounted) {
      perfMark("deferred-commit", markId);
      return;
    }
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, markId]);
  return mounted ? children : fallback;
}
