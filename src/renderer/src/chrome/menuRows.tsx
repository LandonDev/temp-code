import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Tip } from "../components/tip";
import { menuChunk } from "../surfaces/chunks";
import type { IconComponent } from "./icons";
import type * as Body from "./menuBody";

/**
 * A menu's rows as data, and the three ways a surface opens them. Every menu
 * of verbs builds a `MenuRow[]`: a `RowsMenu` drops it from a trigger, a
 * `RowsContextMenu` opens it at the pointer, and the rows look the same on
 * every surface: the 14px glyph, the label, a second line when the row needs
 * one, and the key cap of a real binding (lib/settings.ts `shortcutFor`).
 * Content (a picker, a list of accounts) floats in a `LazyPopover`.
 *
 * Base UI's menu, context menu and popover (with their floating stack) stay
 * out of the first paint: they live in chrome/menuBody.tsx behind
 * `menuChunk` (surfaces/chunks.ts), the way the tooltip defers its primitive. Until the chunk has
 * landed, a menu is its trigger alone; the pointer entering any trigger, or
 * a focus on one, loads it, after which every menu on screen swaps to the
 * real one at once (once; the swap waits while a field is being typed in).
 * A click or right-click on a cold trigger loads the chunk and opens the
 * menu as soon as it has landed.
 */

export type MenuRowsKind = "dropdown" | "context";

export type MenuRow =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: IconComponent;
      /** One chord's caps, from `shortcutFor`; never typed by hand. */
      shortcut?: string;
      /** A second line under the label (a disabled move's reason). */
      description?: string;
      /** A quiet fact at the row's end: a count, a time. */
      hint?: string;
      disabled?: boolean;
      danger?: boolean;
      /** Set: a checkbox row, ticked while true. */
      checked?: boolean;
    }
  | { kind: "sep" }
  | { kind: "label"; label: string }
  /** A line that is not a verb (the ⋯ menu's host and cost). */
  | { kind: "note"; id: string; content: ReactNode }
  | { kind: "sub"; id: string; label: string; icon?: IconComponent; items: MenuRow[]; disabled?: boolean };

/** No separator first, last or twice in a row, and none under a label. */
export function tidy(rows: readonly MenuRow[]): MenuRow[] {
  const out: MenuRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (row.kind === "sep" && (!prev || prev.kind === "sep" || prev.kind === "label")) continue;
    out.push(row);
  }
  while (out.length && (out[out.length - 1]!.kind === "sep" || out[out.length - 1]!.kind === "label")) out.pop();
  return out;
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The body every menu renders with: set by `wake` alone, so one menu
 *  re-rendering after the chunk landed does not swap on its own. */
let published: typeof Body | null = null;
const read = (): typeof Body | null => published;

/** A field being typed in: a swap now would remount it under the keyboard. */
function typing(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable);
}

function wake(): void {
  if (published) return;
  if (typing()) {
    document.addEventListener("focusout", () => queueMicrotask(wake), { once: true });
    return;
  }
  published = menuChunk.loaded();
  for (const listener of listeners) listener();
}

/** Loads the menus' body and swaps every cold menu on screen to it. */
export function warmMenus(): void {
  if (published) return;
  if (menuChunk.loaded()) wake();
  else menuChunk.load().then(wake, () => {});
}

/** Test seam: forget the published body. */
export function resetMenus(): void {
  published = null;
}

function useBody(): typeof Body | null {
  return useSyncExternalStore(subscribe, read, read);
}

type Handlers = Record<string, ((event: SyntheticEvent) => void) | undefined>;
/** The trigger with `extra` handlers run after its own. */
function chain(element: ReactElement, extra: Handlers, attrs: Record<string, unknown> = {}): ReactElement {
  const own = element.props as Handlers;
  const merged: Handlers = {};
  for (const [name, handler] of Object.entries(extra)) {
    merged[name] = (event) => {
      own[name]?.(event);
      handler?.(event);
    };
  }
  return cloneElement(element, { ...attrs, ...merged });
}

export type TipProps = { label: string; shortcut?: string; side?: "top" | "bottom" | "left" | "right" };

export type RowsMenuProps = {
  /** The button that opens the menu (a `Button`, usually ghost icon-sm). */
  trigger: ReactElement;
  /** The menu's accessible name. */
  label: string;
  /** The rows, or a function giving them, called only while the menu is open. */
  rows: readonly MenuRow[] | (() => readonly MenuRow[]);
  onPick: (id: string) => void;
  /** Opened: load what the rows need. */
  onOpenChange?: (open: boolean) => void;
  /** The trigger's name on hover, with its binding's cap. */
  tip?: TipProps;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** The popup's classes (a width). */
  className?: string;
  size?: "sm" | "default";
};

/** A menu of verbs dropped from a trigger (`DropdownMenu`). */
export function RowsMenu(props: RowsMenuProps) {
  const B = useBody();
  const [pending, setPending] = useState(false);
  if (B) return <B.DropdownRows {...props} defaultOpen={pending} onOpenChange={(open) => {
    if (!open) setPending(false);
    props.onOpenChange?.(open);
  }} />;
  const cold = chain(
    props.trigger,
    {
      onPointerEnter: warmMenus,
      onFocus: () => menuChunk.preload(),
      onClick: () => {
        setPending(true);
        props.onOpenChange?.(true);
        if (menuChunk.loaded()) wakeNow();
        else menuChunk.load().then(wakeNow, () => {});
      },
    },
    { "aria-haspopup": "menu", "aria-expanded": false },
  );
  return props.tip ? <Tip label={props.tip.label} shortcut={props.tip.shortcut} side={props.tip.side}>{cold}</Tip> : cold;
}

/** The person asked for this menu: swap now, even with a field focused
 *  elsewhere (the click moved the focus to the trigger). */
function wakeNow(): void {
  if (published) return;
  published = menuChunk.loaded();
  for (const listener of listeners) listener();
}

export type RowsContextMenuProps = {
  /** The element (or the list) the right-click lands on. Rows inside a list
   *  carry `data-menu-id`; the menu reads it from the clicked row, or from
   *  the focused one when opened from the keyboard. */
  children: ReactElement;
  label: string;
  /** The rows for the clicked id (null outside a row); empty or null keeps the menu shut. */
  rowsFor: (id: string | null) => readonly MenuRow[] | null;
  onPick: (pick: string, id: string | null) => void;
  onOpenChange?: (open: boolean, id: string | null) => void;
  disabled?: boolean;
};

/** Where a right-click asked for the menu: the point, the row's id, the row itself. */
export type MenuAt = { x: number; y: number; id: string | null; row: HTMLElement | null };

/**
 * A menu of verbs at the pointer (`ContextMenu`). The list stays the same
 * element through the swap (nothing under it remounts): it takes the
 * right-click and hands it to the body, which sits beside it once loaded.
 */
export function RowsContextMenu(props: RowsContextMenuProps) {
  const B = useBody();
  const opener = useRef<((at: MenuAt) => void) | null>(null);
  const pending = useRef<MenuAt | null>(null);
  useEffect(() => {
    const at = pending.current;
    if (!B || !at || !opener.current) return;
    pending.current = null;
    opener.current(at);
  }, [B]);
  const child = props.disabled
    ? props.children
    : chain(props.children, {
        onPointerEnter: warmMenus,
        onContextMenu: (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const row = (target?.closest("[data-menu-id]") as HTMLElement | null) ?? null;
          const id = row?.getAttribute("data-menu-id") ?? null;
          event.preventDefault();
          if (!props.rowsFor(id)?.length) return;
          event.stopPropagation();
          const mouse = event.nativeEvent as MouseEvent;
          let x = mouse.clientX;
          let y = mouse.clientY;
          // The keyboard's context-menu key: under the row it came from.
          if (x === 0 && y === 0 && row) {
            const rect = row.getBoundingClientRect();
            x = rect.left;
            y = rect.bottom;
          }
          const at = { x, y, id, row };
          if (opener.current) opener.current(at);
          else {
            pending.current = at;
            if (menuChunk.loaded()) wakeNow();
            else menuChunk.load().then(wakeNow, () => {});
          }
        },
      });
  return (
    <>
      {child}
      {B && !props.disabled ? <B.ContextRows {...props} opener={opener} /> : null}
    </>
  );
}

export type LazyPopoverProps = {
  /** The control that opens it; omit with `anchor` for a popover opened from elsewhere. */
  trigger?: ReactElement;
  /** An element (or a virtual one with getBoundingClientRect) to float from. */
  anchor?: Element | { getBoundingClientRect: () => DOMRect } | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  tip?: TipProps;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  className?: string;
  /** The popup's accessible name. */
  label?: string;
  /** Rendered only while open; never imports a menu or popover primitive. */
  children: ReactNode;
};

/** Content floating from a trigger or an anchor (`Popover`). */
export function LazyPopover(props: LazyPopoverProps) {
  const B = useBody();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!B && props.open) menuChunk.load().then(wakeNow, () => {});
  }, [B, props.open]);
  if (B) return <B.PopoverBody {...props} defaultOpen={pending} onOpenChange={(open) => {
    if (!open) setPending(false);
    props.onOpenChange?.(open);
  }} />;
  if (!props.trigger) return null;
  const cold = chain(
    props.trigger,
    {
      onPointerEnter: warmMenus,
      onFocus: () => menuChunk.preload(),
      onClick: () => {
        setPending(true);
        props.onOpenChange?.(true);
        if (menuChunk.loaded()) wakeNow();
        else menuChunk.load().then(wakeNow, () => {});
      },
    },
    { "aria-haspopup": "dialog", "aria-expanded": false },
  );
  return props.tip ? <Tip label={props.tip.label} shortcut={props.tip.shortcut} side={props.tip.side}>{cold}</Tip> : cold;
}
