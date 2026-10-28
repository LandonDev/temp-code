import { useEffect, useRef, type ReactNode } from "react";
import { defaultRangeExtractor, measureElement, observeElementRect, useVirtualizer, type Rect, type VirtualizerOptions } from "@tanstack/react-virtual";

/** What the rail's list hands either mode (chrome/railRows.tsx). */
export type RailRowsProps = {
  count: number;
  /** The element that scrolls: state, not a ref, so its arrival re-renders
   *  the list and the virtualizer attaches to it whatever is selected. */
  scroller: HTMLElement | null;
  /** The list's offset inside the scroller (its padding above the rows). */
  scrollMargin: number;
  /** Where a list mounting with no scroller yet starts (the column's memory). */
  initialOffset?: number;
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
const measureRow: VirtualizerOptions<HTMLElement, HTMLDivElement>["measureElement"] = (
  node,
  entry,
  instance,
) => {
  if (entry) return measureElement(node, entry, instance);
  const index = instance.indexFromElement(node);
  return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
};

/** The last size each keyed scroller reported (`sizeKey`). */
const lastRects = new Map<string, Rect>();

/** The scroller's size from the ResizeObserver alone, which reports once on
 *  observe after layout: a list mounting under a switch starts from the size
 *  its key last had instead of reading the scroller, which would force a
 *  layout in the middle of the commit. A key never seen reads once. */
function rectFromObserver(key: string): VirtualizerOptions<HTMLElement, HTMLDivElement>["observeElementRect"] {
  return (instance, cb) => {
    const record = (rect: Rect) => {
      if (rect.width > 0 || rect.height > 0) lastRects.set(key, rect);
      cb(rect);
    };
    const element = instance.scrollElement;
    if (!lastRects.has(key) || !element || typeof ResizeObserver === "undefined") return observeElementRect(instance, record);
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      record(box ? { width: Math.round(box.inlineSize), height: Math.round(box.blockSize) } : { width: element.offsetWidth, height: element.offsetHeight });
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  };
}

/**
 * The rail's cards, virtualized: only those near the viewport are mounted.
 * Rides virtualChunk, out of the first paint; until it lands the rail
 * renders the same cards plainly (railRows.tsx). The right panel's Changes
 * list (rail/ChangesPanel.tsx, in the lazy right panel chunk) uses it too.
 */
export function VirtualRows({
  count,
  scroller,
  scrollMargin,
  initialOffset,
  estimateSize,
  getItemKey,
  render,
  reveal,
  gap = RAIL_GAP_PX,
  sizeKey,
}: RailRowsProps & {
  /** Between rows; the rail's cards by default (the Changes list sets its own spacing). */
  gap?: number;
  /** Lists that share a key share a remembered scroller size (`rectFromObserver`). */
  sizeKey?: string;
}) {
  // The row holding focus stays mounted when it scrolls out of the window:
  // unmounting it would drop the keyboard's place to the page. By key, so a
  // row added or removed above it does not hand the place to another row.
  const focused = useRef<string | null>(null);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count,
    getScrollElement: () => scroller,
    scrollMargin,
    estimateSize,
    getItemKey,
    overscan: 4,
    gap,
    measureElement: measureRow,
    rangeExtractor: (range) => {
      const rows = defaultRangeExtractor(range);
      const key = focused.current;
      if (key === null || rows.some((i) => getItemKey(i) === key)) return rows;
      for (let i = 0; i < range.count; i++) if (getItemKey(i) === key) return [...rows, i].sort((a, b) => a - b);
      return rows;
    },
    ...(sizeKey ? { observeElementRect: rectFromObserver(sizeKey), initialRect: lastRects.get(sizeKey) } : {}),
    // Swapped in under a list the person may have scrolled: start where it
    // is; mounted again before its scroller: start where the column was.
    initialOffset: () => scroller?.scrollTop ?? initialOffset ?? 0,
  });
  // A reveal the plain list already answered is not replayed at the swap.
  const answered = useRef(reveal);
  useEffect(() => {
    if (!reveal || reveal === answered.current) return;
    answered.current = reveal;
    virtualizer.scrollToIndex(reveal.index, { align: "auto" });
  }, [reveal, virtualizer]);
  return (
    <div
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      onFocus={(event) => {
        const row = (event.target as HTMLElement).closest("[data-index]");
        focused.current = row ? getItemKey(Number(row.getAttribute("data-index"))) : null;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focused.current = null;
      }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          {render(row.index)}
        </div>
      ))}
    </div>
  );
}
