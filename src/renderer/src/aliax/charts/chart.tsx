import { useEffect, useRef, useState, type ReactElement } from "react";
import { ResponsiveContainer } from "recharts";

/**
 * The defaults every chart shares, written once: horizontal grid lines on
 * the border token, axes with no lines and 11px muted ticks, lines 2px with
 * no dots, bars rounded on their data end, and no series ever animates.
 */
export const GRID = { vertical: false, stroke: "var(--border)" } as const;

const TICK = { fill: "var(--muted-foreground)", fontSize: 11, fontVariantNumeric: "tabular-nums" } as const;

export const AXIS = { axisLine: false, tickLine: false, tick: TICK, tickMargin: 8 } as const;

/** The hover cursor: a hairline on line and area charts, a faint band on bars. */
export const LINE_CURSOR = { stroke: "var(--border)", strokeWidth: 1 } as const;
export const BAR_CURSOR = { fill: "var(--foreground)", fillOpacity: 0.05 } as const;

export const ACTIVE_DOT = { r: 4, strokeWidth: 2, stroke: "var(--background)" } as const;

export const LINE = { type: "monotone", strokeWidth: 2, dot: false, activeDot: ACTIVE_DOT, isAnimationActive: false } as const;

export const BAR = { radius: [4, 4, 0, 0] as [number, number, number, number], isAnimationActive: false } as const;

export const HBAR = { radius: [0, 4, 4, 0] as [number, number, number, number], isAnimationActive: false } as const;

/** True once the element comes within 400px of the viewport, so a long page mounts its charts as they near the screen. */
function useNearViewport<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setSeen(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** One chart's plot area: a fixed height, the chart mounted once it nears the screen. */
export function ChartFrame({ label, height = 200, children }: { label: string; height?: number; children: ReactElement }) {
  const [ref, visible] = useNearViewport<HTMLDivElement>();
  return (
    <div ref={ref} data-chart role="img" aria-label={label} style={{ height }} className="w-full">
      {visible ? (
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
