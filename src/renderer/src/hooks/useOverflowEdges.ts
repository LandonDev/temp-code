import { useCallback, useRef } from "react";

/** The classes that fade a strip's cut edge: 24px of mask on each side that
 *  has more beyond it, none on a side that ends there. */
export const OVERFLOW_FADE =
  "data-overflow-start:[--fade-start:24px] data-overflow-end:[--fade-end:24px] [mask-image:linear-gradient(90deg,transparent,var(--foreground)_var(--fade-start,0px),var(--foreground)_calc(100%-var(--fade-end,0px)),transparent)]";

/**
 * Marks a horizontal scroller `data-overflow-start` / `data-overflow-end`
 * while there is more of it past that edge, so the cut edge can fade and say
 * so. Written straight to the element on scroll and resize, never through
 * React state, and nothing runs at rest.
 */
export function useOverflowEdges<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const read = () => markOverflowEdges(el);
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    ro?.observe(el);
    cleanup.current = () => {
      el.removeEventListener("scroll", read);
      ro?.disconnect();
    };
  }, []);
}

/** Set the two flags from where `el` is scrolled; a 1px slack ignores rounding. */
export function markOverflowEdges(el: HTMLElement): void {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  el.toggleAttribute("data-overflow-start", start);
  el.toggleAttribute("data-overflow-end", end);
}
