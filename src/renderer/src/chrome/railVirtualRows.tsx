import { useEffect, type ReactNode, type RefObject } from "react";
import { measureElement, useVirtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";

/** What the rail's list hands either mode (chrome/railRows.tsx). */
export type RailRowsProps = {
  count: number;
  scroller: RefObject<HTMLDivElement | null>;
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => string;
  render: (index: number) => ReactNode;
  /** Bring this item on screen; a new object asks again. */
  reveal: { index: number } | null;
};

/** The gap between cards, in both modes. */
export const RAIL_GAP_PX = 4;

/** Row sizes come from the ResizeObserver, which reports every row once on
 *  observe and again when it grows: a row mounting under a switch keeps its
 *  cached or estimated size instead of reading a rect, which would force a
 *  layout per new row before the paint. */
const measureRow: VirtualizerOptions<HTMLDivElement, HTMLDivElement>["measureElement"] = (
  node,
  entry,
  instance,
) => {
  if (entry) return measureElement(node, entry, instance);
  const index = instance.indexFromElement(node);
  return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
};

/**
 * The rail's cards, virtualized: only those near the viewport are mounted.
 * Rides virtualChunk, out of the first paint; until it lands the rail
 * renders the same cards plainly (railRows.tsx).
 */
export function VirtualRows({ count, scroller, estimateSize, getItemKey, render, reveal }: RailRowsProps) {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize,
    getItemKey,
    overscan: 4,
    gap: RAIL_GAP_PX,
    measureElement: measureRow,
  });
  useEffect(() => {
    if (reveal) virtualizer.scrollToIndex(reveal.index, { align: "auto" });
  }, [reveal, virtualizer]);
  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${row.start}px)` }}
        >
          {render(row.index)}
        </div>
      ))}
    </div>
  );
}
