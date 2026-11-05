import { useEffect, useRef, type KeyboardEvent } from "react";

/**
 * A page's list as one tab stop with arrows (the Inbox, Notes): the
 * selected row takes Tab (the first row while nothing visible is selected)
 * and every other row is -1, as `JumpList` does. ↑↓ in the list's filter
 * field or on a focused row select the next or previous row as a click
 * would and scroll it into view; on a row, Home and End go to the ends and
 * focus follows the selection. The ends hold: nothing wraps.
 *
 * Put `listRef` on the list, `data-roving-key={key}`, `tabIndex={tabIndexOf(key)}`
 * and `onKeyDown={onRowKeyDown}` on each row, and `onKeyDown={onFieldKeyDown}`
 * on the field.
 */
export function useRovingList<T extends HTMLElement = HTMLUListElement>({
  keys,
  selected,
  onSelect,
}: {
  /** The visible rows' keys, in order. */
  keys: readonly string[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const listRef = useRef<T>(null);
  const pending = useRef<{ key: string; focus: boolean } | null>(null);

  const land = () => {
    const move = pending.current;
    if (!move) return;
    pending.current = null;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-roving-key="${CSS.escape(move.key)}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
    if (move.focus) row?.focus();
  };

  // The selection lands in the next commit; its row is scrolled to (and
  // focused) once it is drawn as selected.
  useEffect(land, [selected]);

  const step = (event: KeyboardEvent<HTMLElement>, focus: boolean) => {
    const ends = focus && (event.key === "Home" || event.key === "End");
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && !ends) return;
    if (keys.length === 0) return;
    event.preventDefault();
    const at = selected === null ? -1 : keys.indexOf(selected);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? keys.length - 1
          : event.key === "ArrowDown"
            ? Math.min(keys.length - 1, at + 1)
            : at === -1
              ? 0
              : Math.max(0, at - 1);
    const key = keys[next]!;
    pending.current = { key, focus };
    if (key === selected) land();
    else onSelect(key);
  };

  const stop = selected !== null && keys.includes(selected) ? selected : (keys[0] ?? null);

  return {
    listRef,
    onFieldKeyDown: (event: KeyboardEvent<HTMLElement>) => step(event, false),
    onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => step(event, true),
    tabIndexOf: (key: string) => (key === stop ? 0 : -1),
  };
}
