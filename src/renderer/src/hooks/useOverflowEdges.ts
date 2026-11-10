import { useCallback, useRef } from "react";

/** The classes that fade a strip's cut edge: 24px of mask on each side that
 *  has more beyond it, none on a side that ends there. A side that holds a
 *  control over its edge (the live row's scroll arrows) keeps it clear first:
 *  `--fade-clear-start` / `--fade-clear-end` are that room, the ramp starting
 *  after it (0 by default, so the edge itself fades). */
export const OVERFLOW_FADE =
  "data-overflow-start:[--fade-start:24px] data-overflow-end:[--fade-end:24px] [mask-image:linear-gradient(90deg,transparent_var(--fade-clear-start,0px),var(--foreground)_calc(var(--fade-clear-start,0px)_+_var(--fade-start,0px)),var(--foreground)_calc(100%_-_var(--fade-clear-end,0px)_-_var(--fade-end,0px)),transparent_calc(100%_-_var(--fade-clear-end,0px)))]";

/** The vertical twin, for a column capped in height (the reasoning column
 *  under the working line): 32px of mask at a top or bottom edge with more
 *  past it. */
export const OVERFLOW_FADE_Y =
  "data-overflow-start:[--fade-start:32px] data-overflow-end:[--fade-end:32px] [mask-image:linear-gradient(180deg,transparent_0px,var(--foreground)_var(--fade-start,0px),var(--foreground)_calc(100%_-_var(--fade-end,0px)),transparent_100%)]";

export type OverflowAxis = "x" | "y";

/**
 * Marks a scroller `data-overflow-start` / `data-overflow-end` while there
 * is more of it past that edge, so the cut edge can fade and say so: a
 * horizontal strip by default, a column with `axis: "y"`. Written straight
 * to the element on scroll and resize, never through React state, and
 * nothing runs at rest.
 */
export function useOverflowEdges<T extends HTMLElement>(axis: OverflowAxis = "x") {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (el: T | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!el) return;
      const read = () => markOverflowEdges(el, axis);
      read();
      el.addEventListener("scroll", read, { passive: true });
      const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
      ro?.observe(el);
      cleanup.current = () => {
        el.removeEventListener("scroll", read);
        ro?.disconnect();
      };
    },
    [axis],
  );
}

/** Set the two flags from where `el` is scrolled; a 1px slack ignores rounding. */
export function markOverflowEdges(el: HTMLElement, axis: OverflowAxis = "x"): void {
  const start = axis === "x" ? el.scrollLeft > 1 : el.scrollTop > 1;
  const end = axis === "x" ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  el.toggleAttribute("data-overflow-start", start);
  el.toggleAttribute("data-overflow-end", end);
}
