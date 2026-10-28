import { useEffect, useState } from "react";
import { virtualChunk } from "../surfaces/chunks";
import type { RailRowsProps, VirtualRows as VirtualRowsType } from "./railVirtualRows";

/** The rail list's padding above its first card (WorkspaceSessions' pt-2),
 *  inside the sidebar's scroller: the virtualizer's scroll margin. Here, not
 *  in railVirtualRows, which must stay out of the first paint. */
export const RAIL_SCROLL_MARGIN_PX = 8;

/** Past this many rows the virtualizer loads at once instead of in an idle slot. */
export const VIRTUAL_AT_ROWS = 200;

type Props = RailRowsProps & {
  /** The list's rows, roughly: what decides whether the virtualizer is urgent. */
  rows: number;
};

/**
 * The rail's cards: every one rendered in order, in flow, until
 * `@tanstack/react-virtual` arrives through virtualChunk (an idle slot, or at
 * once past VIRTUAL_AT_ROWS rows); then the same cards virtualize with the
 * same gap, in the same scroller, which keeps its offset.
 */
export function RailRows({ rows, ...props }: Props) {
  const [Virtual, setVirtual] = useState<typeof VirtualRowsType | null>(() => virtualChunk.loaded()?.VirtualRows ?? null);
  const urgent = rows > VIRTUAL_AT_ROWS;
  useEffect(() => {
    if (Virtual) return;
    let live = true;
    const land = () => {
      void virtualChunk.load().then(
        (m) => live && setVirtual(() => m.VirtualRows),
        () => {},
      );
    };
    if (urgent) {
      land();
      return () => {
        live = false;
      };
    }
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    const id = typeof idle === "function" ? idle(land, { timeout: 2000 }) : setTimeout(land, 250);
    return () => {
      live = false;
      if (typeof idle === "function") cancel?.(id as number);
      else clearTimeout(id as ReturnType<typeof setTimeout>);
    };
  }, [Virtual, urgent]);
  return Virtual ? <Virtual {...props} /> : <PlainRows {...props} />;
}

/** Every card in flow, 4px apart like the virtual list. */
function PlainRows({ count, scroller, getItemKey, render, reveal }: RailRowsProps) {
  useEffect(() => {
    if (!reveal) return;
    scroller?.querySelector(`[data-index="${reveal.index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [reveal, scroller]);
  return (
    <div className="flex w-full flex-col gap-1">
      {Array.from({ length: count }, (_, index) => (
        <div key={getItemKey(index)} data-index={index}>
          {render(index)}
        </div>
      ))}
    </div>
  );
}
