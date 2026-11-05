import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * A keyboard list's highlight that follows the pointer only when the pointer
 * moves (Search, Go to File, Go to Symbol). The arrows move the highlight and
 * scroll it into view; the list then slides under a pointer that never
 * moved, and the `mouseenter` that fires on the row now under it must not
 * take the highlight back. So a row's enter counts only after a real
 * `mousemove` over the list, and a keyboard move (or new rows) waits for the
 * next one. The browser sends a row's `mouseenter` before the `mousemove`
 * that re-arms the pointer, so the move that re-arms it also lights the row
 * it is over (the list's options, in order, are the indexes).
 *
 * Spread `onMouseMove` on the list, put `activeRef` on the highlighted row
 * and call `onRowEnter(index)` from each row's `onMouseEnter`.
 */
export function usePointerHighlight<T extends HTMLElement>({
  active,
  items,
  onActive,
}: {
  /** The highlighted index. */
  active: number;
  /** The rows; a new list waits for the pointer to move again. */
  items: unknown;
  onActive: (index: number) => void;
}) {
  const activeRef = useRef<T>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [items]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.clientX === pointer.current.x && event.clientY === pointer.current.y) return;
    const armed = pointer.current.allow;
    pointer.current = { x: event.clientX, y: event.clientY, allow: true };
    if (armed) return;
    const row = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (!row || !event.currentTarget.contains(row)) return;
    const index = [...event.currentTarget.querySelectorAll('[role="option"]')].indexOf(row);
    if (index >= 0) onRowEnter(index);
  };

  const onRowEnter = (index: number) => {
    // The row already lit changes nothing, so it must not mark the next
    // (keyboard) move as the pointer's and skip that move's scroll.
    if (!pointer.current.allow || index === active) return;
    fromPointer.current = true;
    onActive(index);
  };

  return { activeRef, onMouseMove, onRowEnter };
}
