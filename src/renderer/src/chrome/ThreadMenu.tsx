import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item";
import { Kbd } from "../components/ui/kbd";
import { Popover, PopoverContent } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { MOD } from "../lib/platform";
import { THREAD_GLYPHS, timeAgo } from "../surfaces/threads/bits";
import type { ExplorerMenuItem } from "./ExplorerMenu";
import { HostGlyph } from "./HostGlyph";
import { ArchiveRestore, MoreHorizontal, PanelRight } from "./icons";
import { chipTitle, type ArchivedThread, type StripChip } from "./ThreadHeaderStrip";

/**
 * The title bar's right end in deck layout: the ⋯ thread menu, then the
 * panel toggle (last, nearest the panel it opens). The menu holds a quiet
 * line naming the host and the thread's cost, the active thread's own rows
 * (the same list its chip's right-click shows, rendered by `MenuRows`), and
 * the project's items: Pause all, Dev server, Terminal, Recent threads and
 * Archived threads.
 */

export type MenuRowsKind = "dropdown" | "context";

/** A thread's row: an item, a separator, or a submenu of items (Type). */
export type ThreadMenuItem = ExplorerMenuItem | { kind: "sub"; id: string; label: string; items: ExplorerMenuItem[] };

/** The one renderer for a thread's rows, in the ⋯ menu and the chip's
 *  right-click alike, so the two never drift. */
export function MenuRows({
  items,
  onPick,
  kind,
}: {
  items: readonly ThreadMenuItem[];
  onPick: (id: string) => void;
  kind: MenuRowsKind;
}) {
  const Row = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Check = kind === "dropdown" ? DropdownMenuCheckboxItem : ContextMenuCheckboxItem;
  const Sep = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  const Sub = kind === "dropdown" ? DropdownMenuSub : ContextMenuSub;
  const SubTrigger = kind === "dropdown" ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
  const SubContent = kind === "dropdown" ? DropdownMenuSubContent : ContextMenuSubContent;
  return (
    <>
      {items.map((item, index) => {
        if (item.kind === "sep") return <Sep key={`sep-${index}`} />;
        if (item.kind === "sub") {
          return (
            <Sub key={item.id}>
              <SubTrigger>{item.label}</SubTrigger>
              <SubContent>
                <MenuRows items={item.items} onPick={onPick} kind={kind} />
              </SubContent>
            </Sub>
          );
        }
        const label = item.description ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>{item.label}</span>
            <span className="text-[12px] text-muted-foreground">{item.description}</span>
          </span>
        ) : (
          item.label
        );
        if (item.checked !== undefined) {
          return (
            <Check
              key={item.id}
              checked={item.checked}
              disabled={item.disabled}
              closeOnClick
              onCheckedChange={() => onPick(item.id)}
            >
              {label}
            </Check>
          );
        }
        return (
          <Row
            key={item.id}
            disabled={item.disabled}
            variant={item.danger ? "destructive" : "default"}
            onClick={() => onPick(item.id)}
          >
            {label}
          </Row>
        );
      })}
    </>
  );
}

/** Groups with nothing in them drop out, and no separator is left hanging. */
function groups(...parts: ReactNode[][]): ReactNode[] {
  const out: ReactNode[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (out.length > 0) out.push(<DropdownMenuSeparator key={`group-${out.length}`} />);
    out.push(...part);
  }
  return out;
}

export type ThreadMenuProps = {
  /** The active thread's host, when the window has two or more. */
  host: { environmentId: string; name: string } | null;
  /** The active thread's cost in dollars, when known. */
  cost: number | null;
  /** The active thread's rows (chipMenuItems plus its host moves); empty without one. */
  rows: readonly ThreadMenuItem[];
  onPick: (id: string) => void;
  /** The menu opened: load what the thread's rows need (bridge, resources). */
  onOpen?: () => void;
  /** Roots with live work in the project. */
  running: number;
  onPauseAll: () => Promise<unknown>;
  /** Shown when a host can serve the project or one of its servers runs. */
  dev: { shown: boolean; open: boolean; onToggle: () => void };
  terminal: { onShow?: () => void; onNew?: () => void; active: boolean };
  /** Settled threads, freshest first. */
  recent: readonly StripChip[];
  onOpenRecent: (id: string) => void;
  archived: readonly ArchivedThread[];
  onRestore: (id: string) => void;
  panel: { open: boolean; onToggle: () => void };
};

const RECENT_MAX = 12;

export function ThreadMenu({
  host,
  cost,
  rows,
  onPick,
  onOpen,
  running,
  onPauseAll,
  dev,
  terminal,
  recent,
  onOpenRecent,
  archived,
  onRestore,
  panel,
}: ThreadMenuProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const shownCost = cost != null && cost > 0 ? `$${cost.toFixed(2)}` : null;
  const openTerminal = terminal.active ? (terminal.onShow ?? terminal.onNew) : terminal.onNew;

  const quiet: ReactNode[] =
    host || shownCost
      ? [
          <div
            key="line"
            data-thread-line
            className="flex items-center gap-2 px-1.5 py-1 text-[12px] text-muted-foreground"
          >
            {host ? (
              <span className="flex min-w-0 items-center gap-1.5" data-thread-host={host.environmentId}>
                <HostGlyph environmentId={host.environmentId} />
                <span className="truncate">{host.name}</span>
              </span>
            ) : null}
            {shownCost ? <span className="ms-auto tabular-nums">{shownCost}</span> : null}
          </div>,
        ]
      : [];
  const own: ReactNode[] = rows.length ? [<MenuRows key="rows" items={rows} onPick={onPick} kind="dropdown" />] : [];
  const project: ReactNode[] = [];
  if (running > 0) {
    project.push(
      <DropdownMenuItem
        key="pause-all"
        onClick={() => {
          onPauseAll().catch(() => toast.error("Couldn't pause every thread"));
        }}
      >
        Pause all
        <span className="ms-auto tabular-nums text-muted-foreground">{running}</span>
      </DropdownMenuItem>,
    );
  }
  if (dev.shown) {
    project.push(
      <DropdownMenuCheckboxItem key="dev" checked={dev.open} closeOnClick onCheckedChange={dev.onToggle}>
        Dev server
      </DropdownMenuCheckboxItem>,
    );
  }
  if (openTerminal) {
    project.push(
      <DropdownMenuItem key="terminal" onClick={openTerminal}>
        Terminal
        <DropdownMenuShortcut className="ms-auto">
          <Kbd size="sm">{MOD}`</Kbd>
        </DropdownMenuShortcut>
      </DropdownMenuItem>,
    );
  }
  if (recent.length > 0) {
    project.push(
      <DropdownMenuSub key="recent">
        <DropdownMenuSubTrigger>Recent threads</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64">
          {recent.slice(0, RECENT_MAX).map((chip) => {
            const Glyph = THREAD_GLYPHS[chip.thread.threadType ?? "chat"];
            return (
              <DropdownMenuItem key={chip.id} data-recent={chip.id} onClick={() => onOpenRecent(chip.id)}>
                <Glyph strokeWidth={1.5} />
                <span className="min-w-0 truncate">{chipTitle(chip)}</span>
                <span className="ms-auto shrink-0 ps-2 tabular-nums text-muted-foreground">{timeAgo(chip.updatedAt)}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>,
    );
  }
  if (archived.length > 0) {
    project.push(
      <DropdownMenuItem key="archived" onClick={() => setArchivedOpen(true)}>
        Archived threads…
      </DropdownMenuItem>,
    );
  }

  return (
    <div className="mr-1.5 flex shrink-0 items-center gap-0.5" data-tauri-drag-region="false">
      <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                ref={anchor}
                aria-label="Thread menu"
                render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" />}
              />
            }
          >
            <MoreHorizontal strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipContent side="bottom">Thread menu</TooltipContent>
        </Tooltip>
        <DropdownMenuContent size="sm" align="end" className="w-60" aria-label="Thread menu">
          {groups(quiet, own, project)}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Panel"
              aria-pressed={panel.open}
              onClick={panel.onToggle}
              className="text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/7 aria-pressed:text-foreground"
            />
          }
        >
          <PanelRight strokeWidth={1.5} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Panel
          <Kbd size="sm">{MOD}⇧R</Kbd>
        </TooltipContent>
      </Tooltip>
      <Popover open={archivedOpen} onOpenChange={setArchivedOpen}>
        <PopoverContent anchor={anchor} align="end" className="w-72 gap-1 p-1">
          <ArchivedList archived={archived} onRestore={(id) => {
            if (archived.length === 1) setArchivedOpen(false);
            onRestore(id);
          }} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

const SEARCH_PAST = 6;

/** The selected project's archived threads, freshest first; Restore on hover
 *  puts the thread back and opens it. A search field past six. */
export function ArchivedList({
  archived,
  onRestore,
}: {
  archived: readonly ArchivedThread[];
  onRestore: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? archived.filter((t) => t.title.toLowerCase().includes(q)) : archived;
  return (
    <>
      <div className="px-2 pt-1.5 pb-1 text-[12px] font-medium text-muted-foreground">Archived</div>
      {archived.length > SEARCH_PAST ? (
        <div className="px-1 pb-1">
          <Input
            autoFocus
            aria-label="Search archived threads"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-7 text-[13px]"
          />
        </div>
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        {shown.length === 0 ? <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">No matches</p> : null}
        {shown.map((thread) => {
          const Glyph = THREAD_GLYPHS[thread.type ?? "chat"];
          return (
            <Item
              key={thread.id}
              size="xs"
              data-archived={thread.id}
              render={<button type="button" onClick={() => onRestore(thread.id)} />}
              className="text-left hover:bg-muted"
            >
              <ItemMedia>
                <Glyph className="size-3.5" strokeWidth={1.5} />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full truncate font-normal">{thread.title || "Untitled"}</ItemTitle>
                <ItemDescription className="tabular-nums">{timeAgo(thread.updatedAt)}</ItemDescription>
              </ItemContent>
              <ItemActions className="gap-1 text-[12px] text-muted-foreground opacity-0 transition-opacity duration-(--dur-fast) group-hover/item:opacity-100 group-focus-visible/item:opacity-100">
                <ArchiveRestore className="size-3.5" strokeWidth={1.5} />
                Restore
              </ItemActions>
            </Item>
          );
        })}
      </div>
    </>
  );
}
