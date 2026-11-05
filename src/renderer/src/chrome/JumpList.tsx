import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

/**
 * A list of places to jump to beside a document: the plan's headings, the
 * transcript's messages. A `nav` of ghost rows with one tab stop (the row
 * being read, or the one last focused), arrows and Home/End to move, Enter
 * or Space to jump. The row being read is marked by colour alone and kept
 * in the list's own view, but never while the pointer or focus is in the
 * list, so nothing moves under the hand. Nothing in it animates: it is
 * stepped through tens of times a day.
 */

export type JumpItem = {
  key: string;
  label: ReactNode;
  /** The row's accessible name, when the label is not plain words. */
  name?: string;
  /** Muted, at the row's end (a time). */
  trailing?: ReactNode;
  /** Per-row classes (an indent). */
  className?: string;
};

export type JumpGroup = {
  /** A small heading over the group's rows; null draws none. */
  label: string | null;
  items: JumpItem[];
};

/** `key` for Enter or Space, which lands without a glide; `pointer` for a click. */
export type JumpHow = "key" | "pointer";

export function JumpList({
  id,
  label,
  groups,
  active,
  onJump,
  size = "sm",
  className,
  head,
}: {
  id?: string;
  /** The nav's accessible name. */
  label: string;
  groups: readonly JumpGroup[];
  /** The key of the row being read. */
  active: string | null;
  onJump: (key: string, how: JumpHow) => void;
  /** Rows: 24px (`xs`) or 28px (`sm`). */
  size?: "xs" | "sm";
  /** Placement and size: the nav is its own scroller. */
  className?: string;
  /** A row above the groups with its own action (Earlier messages). */
  head?: ReactNode;
}) {
  const nav = useRef<HTMLElement>(null);
  const hovered = useRef(false);
  const [focused, setFocused] = useState<string | null>(null);
  const keys = groups.flatMap((group) => group.items.map((item) => item.key));
  const stop = focused !== null && keys.includes(focused) ? focused : active !== null && keys.includes(active) ? active : keys[0];

  // Keep the row being read in the list's own view: the nearest edge, at
  // once, and only while the hand is elsewhere.
  useEffect(() => {
    const el = nav.current;
    if (!el || active === null || hovered.current || el.contains(document.activeElement)) return;
    const row = rowIn(el, active);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [active]);

  const focusRow = (key: string | undefined) => {
    if (key === undefined || !nav.current) return;
    setFocused(key);
    rowIn(nav.current, key)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const at = keys.indexOf(key);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(keys[Math.min(keys.length - 1, at + 1)]);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(keys[Math.max(0, at - 1)]);
        return;
      case "Home":
        event.preventDefault();
        focusRow(keys[0]);
        return;
      case "End":
        event.preventDefault();
        focusRow(keys[keys.length - 1]);
        return;
      case "Enter":
      case " ":
        // The keyboard's jump lands at once; preventing the default also
        // keeps the native click from following as a pointer jump.
        event.preventDefault();
        onJump(key, "key");
    }
  };

  return (
    <nav
      ref={nav}
      id={id}
      aria-label={label}
      className={cn("flex flex-col overflow-x-hidden overflow-y-auto overscroll-contain", className)}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
      }}
    >
      {head}
      {groups.map((group, g) => (
        <div
          key={group.label ?? `group-${g}`}
          role={group.label ? "group" : undefined}
          aria-label={group.label ?? undefined}
          className="flex flex-col"
        >
          {group.label ? (
            <div
              aria-hidden
              className={cn(
                "flex h-6 items-end px-2 pb-1 text-[11px] font-medium text-muted-foreground",
                g > 0 && "mt-2",
              )}
            >
              {group.label}
            </div>
          ) : null}
          {group.items.map((item) => {
            const current = item.key === active;
            return (
              <Button
                key={item.key}
                variant="ghost"
                size={size}
                data-jump-key={item.key}
                tabIndex={item.key === stop ? 0 : -1}
                aria-current={current ? "location" : undefined}
                aria-label={item.name}
                className={cn(
                  "w-full min-w-0 justify-start font-normal duration-(--dur-instant)",
                  current ? "text-foreground" : "text-muted-foreground",
                  item.className,
                )}
                onFocus={() => setFocused(item.key)}
                onKeyDown={(event) => onKeyDown(event, item.key)}
                onClick={() => onJump(item.key, "pointer")}
              >
                <span className="min-w-0 truncate">{item.label}</span>
                {item.trailing !== undefined ? (
                  <span className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground tabular-nums">
                    {item.trailing}
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function rowIn(nav: HTMLElement, key: string): HTMLElement | undefined {
  for (const row of nav.querySelectorAll<HTMLElement>("[data-jump-key]")) {
    if (row.dataset.jumpKey === key) return row;
  }
  return undefined;
}
