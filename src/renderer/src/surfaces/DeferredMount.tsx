import { useDeferredValue, useLayoutEffect, type ReactNode } from "react";
import { perfMark } from "../lib/perfMarks";

/**
 * Mounts `children` in a deferred pass after the first commit, so the
 * chrome around it paints with the click that opened it. `fallback` holds
 * the space meanwhile. Key it on what the children show, so a swap defers
 * again.
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
  const mounted = useDeferredValue(true, false);
  useLayoutEffect(() => {
    if (mounted) perfMark("deferred-commit", markId);
  }, [mounted, markId]);
  return mounted ? children : fallback;
}
