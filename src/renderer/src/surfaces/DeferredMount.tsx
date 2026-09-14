import { useDeferredValue, type ReactNode } from "react";

/**
 * Mounts `children` in a deferred pass after the first commit, so the
 * chrome around it paints with the click that opened it. `fallback` holds
 * the space meanwhile. Key it on what the children show, so a swap defers
 * again.
 */
export function DeferredMount({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const mounted = useDeferredValue(true, false);
  return mounted ? children : fallback;
}
