import { useState, type ReactNode } from "react";
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
import type { LazyPopoverProps, MenuRow, MenuRowsKind, RowsContextMenuProps, RowsMenuProps } from "./menuRows";

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

function rowKey(row: MenuRow, index: number): string {
  return row.kind === "item" || row.kind === "sub" || row.kind === "note" ? row.id : `${row.kind}-${index}`;
}

function Row({ item, onPick, kind }: { item: MenuRow; onPick: (id: string) => void; kind: MenuRowsKind }) {
  const { Row: Item, Check, Shortcut, Sub, SubTrigger, SubContent } = PARTS[kind];
  if (item.kind === "sep" || item.kind === "label") return null;
  if (item.kind === "note") {
    return (
      <div data-menu-note={item.id} className="flex items-center gap-2 px-1.5 py-1 text-[12px] text-muted-foreground">
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
  if (item.checked !== undefined) {
    return (
      <Check data-menu-row={item.id} checked={item.checked} disabled={item.disabled} closeOnClick onCheckedChange={() => onPick(item.id)}>
        {body}
      </Check>
    );
  }
  return (
    <Item data-menu-row={item.id} disabled={item.disabled} variant={item.danger ? "destructive" : "default"} onClick={() => onPick(item.id)}>
      {body}
    </Item>
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
  size = "sm",
  defaultOpen,
}: RowsMenuProps & { defaultOpen?: boolean }) {
  const opener = <DropdownMenuTrigger render={trigger} />;
  return (
    <DropdownMenu defaultOpen={defaultOpen} onOpenChange={(open) => onOpenChange?.(open)}>
      {tip ? (
        <Tip label={tip.label} shortcut={tip.shortcut}>
          {opener}
        </Tip>
      ) : (
        opener
      )}
      <DropdownMenuContent size={size} align={align} side={side} className={className} aria-label={label}>
        <MenuRows kind="dropdown" items={rows} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The id the menu opened on: the clicked row's `data-menu-id`, else the
 *  focused one's (a keyboard open), else null. */
function menuIdOf(event: Event | undefined): string | null {
  const target = event?.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-menu-id]") ?? document.activeElement?.closest?.("[data-menu-id]") ?? null;
  return row?.getAttribute("data-menu-id") ?? null;
}

export function ContextRows({ children, label, rowsFor, onPick, onOpenChange, disabled }: RowsContextMenuProps) {
  const [state, setState] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const rows = state.open ? rowsFor(state.id) : null;
  return (
    <ContextMenu
      disabled={disabled}
      open={state.open && !!rows?.length}
      onOpenChange={(open, details) => {
        if (!open) {
          setState((prev) => ({ ...prev, open: false }));
          onOpenChange?.(false, state.id);
          return;
        }
        const id = menuIdOf(details.event);
        if (!rowsFor(id)?.length) return;
        setState({ open: true, id });
        onOpenChange?.(true, id);
      }}
    >
      <ContextMenuTrigger render={children} />
      <ContextMenuContent aria-label={label}>
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
  children,
  defaultOpen,
}: LazyPopoverProps & { defaultOpen?: boolean }) {
  const opener = trigger ? <PopoverTrigger render={trigger} /> : null;
  return (
    <Popover open={open} defaultOpen={open === undefined ? defaultOpen : undefined} onOpenChange={(next) => onOpenChange?.(next)}>
      {opener && tip ? (
        <Tip label={tip.label} shortcut={tip.shortcut}>
          {opener}
        </Tip>
      ) : (
        opener
      )}
      <PopoverContent anchor={anchor ?? undefined} align={align} side={side} sideOffset={sideOffset} className={className} aria-label={label}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
