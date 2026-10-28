import { useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Tip } from "../components/tip";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Kbd } from "../components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import type { LazyPopoverProps, MenuAt, MenuRow, MenuRowsKind, RowsContextMenuProps, RowsMenuProps } from "./menuRows";

/**
 * The menus' body, in its own chunk (`menuChunk`): the Base UI menu, context
 * menu and popover with the one renderer for `MenuRow`s. Nothing outside
 * chrome/menuRows.tsx imports this module; a surface uses `RowsMenu`,
 * `RowsContextMenu` and `LazyPopover` from there.
 */

const PARTS = {
  dropdown: {
    Group: DropdownMenuGroup,
    Row: DropdownMenuItem,
    Check: DropdownMenuCheckboxItem,
    Sep: DropdownMenuSeparator,
    Label: DropdownMenuLabel,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
  context: {
    Group: ContextMenuGroup,
    Row: ContextMenuItem,
    Check: ContextMenuCheckboxItem,
    Sep: ContextMenuSeparator,
    Label: ContextMenuLabel,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
} as const;

/** The rows of one menu. A label heads a group that runs to the next
 *  separator or label (Base UI wants a group label inside its group). */
export function MenuRows({ items, onPick, kind }: { items: readonly MenuRow[]; onPick: (id: string) => void; kind: MenuRowsKind }) {
  const { Group, Label, Sep } = PARTS[kind];
  const out: ReactNode[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind === "sep") {
      out.push(<Sep key={`sep-${index}`} />);
    } else if (item.kind === "label") {
      let end = index + 1;
      while (end < items.length && items[end]!.kind !== "sep" && items[end]!.kind !== "label") end++;
      out.push(
        <Group key={`group-${index}`}>
          <Label>{item.label}</Label>
          {items.slice(index + 1, end).map((row, offset) => (
            <Row key={rowKey(row, index + 1 + offset)} item={row} onPick={onPick} kind={kind} />
          ))}
        </Group>,
      );
      index = end - 1;
    } else {
      out.push(<Row key={rowKey(item, index)} item={item} onPick={onPick} kind={kind} />);
    }
  }
  return <>{out}</>;
}

/**
 * Focus after a menu has finished closing. A pick that opened a dialog
 * gets the dialog's first field (the menu held focus while it closed, so
 * the dialog's own first focus was lost); a pick that moved focus anywhere
 * else keeps it; otherwise focus goes back to `target`.
 */
function restoreFocus(target: HTMLElement | null): void {
  const dialogs = document.querySelectorAll<HTMLElement>("[data-slot='dialog-content'], [data-slot='alert-dialog-content']");
  const dialog = dialogs[dialogs.length - 1];
  const active = document.activeElement;
  if (dialog) {
    if (!dialog.contains(active)) (dialog.querySelector<HTMLElement>("input, textarea, select, button") ?? dialog).focus({ preventScroll: true });
    return;
  }
  if (active && active !== document.body && !active.closest("[data-slot$='menu-content']")) return;
  target?.focus({ preventScroll: true });
}

/** The control a row's menu gives focus back to: the row itself when it
 *  takes focus, else the control inside it (a roving tab's button). */
function focusableOf(row: HTMLElement | null): HTMLElement | null {
  if (!row) return null;
  if (row.matches("button, a[href], input, [tabindex]")) return row;
  return row.querySelector<HTMLElement>("button, a[href], input, [tabindex]") ?? row;
}

/** Rows given as a function are built here, inside the open popup only. */
function OpenRows({ rows, onPick, kind }: { rows: RowsMenuProps["rows"]; onPick: (id: string) => void; kind: MenuRowsKind }) {
  return <MenuRows kind={kind} items={typeof rows === "function" ? rows() : rows} onPick={onPick} />;
}

function rowKey(row: MenuRow, index: number): string {
  return row.kind === "item" || row.kind === "sub" || row.kind === "note" ? row.id : `${row.kind}-${index}`;
}

function Row({ item, onPick, kind }: { item: MenuRow; onPick: (id: string) => void; kind: MenuRowsKind }) {
  const { Row: Item, Check, Shortcut, Sub, SubTrigger, SubContent } = PARTS[kind];
  if (item.kind === "sep" || item.kind === "label") return null;
  if (item.kind === "note") {
    return (
      <div data-menu-note={item.id} className="flex items-center gap-2 px-3 py-1 text-[12px] text-muted-foreground">
        {item.content}
      </div>
    );
  }
  if (item.kind === "sub") {
    const Icon = item.icon;
    return (
      <Sub>
        <SubTrigger disabled={item.disabled} data-menu-row={item.id}>
          {Icon ? <Icon strokeWidth={1.5} /> : null}
          {item.label}
        </SubTrigger>
        <SubContent>
          <MenuRows items={item.items} onPick={onPick} kind={kind} />
        </SubContent>
      </Sub>
    );
  }
  const Icon = item.icon;
  const body = (
    <>
      {Icon ? <Icon strokeWidth={1.5} /> : null}
      {item.description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{item.label}</span>
          <span className="text-[12px] text-muted-foreground">{item.description}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">{item.label}</span>
      )}
      {item.hint ? <span className="ms-auto shrink-0 ps-2 tabular-nums text-muted-foreground">{item.hint}</span> : null}
      {item.shortcut ? (
        <Shortcut>
          <Kbd size="sm">{item.shortcut}</Kbd>
        </Shortcut>
      ) : null}
    </>
  );
  const row =
    item.checked !== undefined ? (
      <Check data-menu-row={item.id} checked={item.checked} disabled={item.disabled} closeOnClick={!item.keepOpen} onCheckedChange={() => onPick(item.id)} aria-description={item.reason}>
        {body}
      </Check>
    ) : (
      <Item data-menu-row={item.id} disabled={item.disabled} variant={item.danger ? "destructive" : "default"} onClick={() => onPick(item.id)} aria-description={item.reason}>
        {body}
      </Item>
    );
  if (!item.reason) return row;
  // A disabled row takes no pointer events: the wrapper is the tooltip's
  // trigger, so the reason shows on hover and the row stays one 28px line.
  return (
    <Tip label={item.reason} side="right">
      <div data-menu-reason={item.id}>{row}</div>
    </Tip>
  );
}

export function DropdownRows({
  trigger,
  label,
  rows,
  onPick,
  onOpenChange,
  tip,
  align = "end",
  side = "bottom",
  className,
  defaultOpen,
  open,
  modal,
  finalFocus,
}: RowsMenuProps & { defaultOpen?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const opener = <DropdownMenuTrigger ref={triggerRef} render={trigger} />;
  return (
    <DropdownMenu
      {...(open === undefined ? { defaultOpen } : { open })}
      modal={modal}
      onOpenChange={(next) => onOpenChange?.(next)}
      onOpenChangeComplete={(next) => !next && finalFocus === undefined && restoreFocus(triggerRef.current)}
    >
      {tip ? (
        <Tip label={tip.label} shortcut={tip.shortcut} side={tip.side}>
          {opener}
        </Tip>
      ) : (
        opener
      )}
      <DropdownMenuContent align={align} side={side} className={className} aria-label={label} finalFocus={finalFocus ?? false}>
        <OpenRows kind="dropdown" rows={rows} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The right-click menu of a list. The list itself is not the trigger (it
 * would remount when this body swaps in): a hidden trigger beside it takes
 * each right-click the list hands over (`opener`), at the same point.
 */
export function ContextRows({
  label,
  rowsFor,
  onPick,
  onOpenChange,
  opener,
}: RowsContextMenuProps & { opener: MutableRefObject<((at: MenuAt) => void) | null> }) {
  const [state, setState] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const trigger = useRef<HTMLSpanElement>(null);
  const asked = useRef<MenuAt | null>(null);
  const back = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    opener.current = (at) => {
      asked.current = at;
      trigger.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
    };
    return () => {
      opener.current = null;
    };
  }, [opener]);
  const rows = state.open ? rowsFor(state.id) : null;
  return (
    <ContextMenu
      open={state.open && !!rows?.length}
      onOpenChangeComplete={(open) => !open && restoreFocus(back.current)}
      onOpenChange={(open) => {
        if (!open) {
          setState((prev) => ({ ...prev, open: false }));
          onOpenChange?.(false, state.id);
          return;
        }
        const at = asked.current;
        asked.current = null;
        if (!at || !rowsFor(at.id)?.length) return;
        back.current = focusableOf(at.row);
        setState({ open: true, id: at.id });
        onOpenChange?.(true, at.id);
      }}
    >
      <ContextMenuTrigger render={<span ref={trigger} aria-hidden className="pointer-events-none fixed size-0" />} />
      <ContextMenuContent aria-label={label} finalFocus={false}>
        {rows ? <MenuRows kind="context" items={rows} onPick={(pick) => onPick(pick, state.id)} /> : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function PopoverBody({
  trigger,
  anchor,
  open,
  onOpenChange,
  tip,
  align = "start",
  side = "bottom",
  sideOffset,
  className,
  label,
  initialFocus,
  finalFocus,
  children,
  defaultOpen,
}: LazyPopoverProps & { defaultOpen?: boolean }) {
  const opener = trigger ? <PopoverTrigger render={trigger} /> : null;
  return (
    <Popover open={open} defaultOpen={open === undefined ? defaultOpen : undefined} onOpenChange={(next) => onOpenChange?.(next)}>
      {opener && tip ? (
        <Tip label={tip.label} shortcut={tip.shortcut} side={tip.side}>
          {opener}
        </Tip>
      ) : (
        opener
      )}
      <PopoverContent anchor={anchor ?? undefined} align={align} side={side} sideOffset={sideOffset} className={className} aria-label={label} initialFocus={initialFocus} finalFocus={finalFocus}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
