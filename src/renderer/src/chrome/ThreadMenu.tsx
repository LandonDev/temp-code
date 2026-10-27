import { useRef, useState } from "react";
import { loadToast } from "../components/ui/toaster";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ItemButton, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item";
import { shortcutFor } from "../lib/settings";
import { THREAD_GLYPHS } from "../surfaces/threads/threadTypes";
import { timeAgo } from "../lib/duration";
import { LazyPopover, RowsMenu, tidy, type MenuRow } from "./menuRows";
import { HostGlyph } from "./HostGlyph";
import { ArchiveRestore, Clock, Globe, MoreHorizontal, PanelRight, Pause, Terminal } from "./icons";
import { chipTitle, type ArchivedThread, type StripChip } from "./ThreadHeaderStrip";

/**
 * The title bar's right end in deck layout: the ⋯ thread menu, then the
 * panel toggle (last, nearest the panel it opens). The menu holds a quiet
 * line naming the host and the thread's cost, the active thread's own rows
 * (lib/threadMenu.ts, the list its chip's right-click shows), and the
 * project's rows: Pause all, Dev server, Terminal, Recent threads and
 * Archived threads.
 */

export type ThreadMenuProps = {
  /** The active thread's host, when the window has two or more. */
  host: { environmentId: string; name: string } | null;
  /** The active thread's cost in dollars, when known. */
  cost: number | null;
  /** The active thread's rows; empty without one. */
  rows: readonly MenuRow[];
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

  const all: MenuRow[] = [];
  if (host || shownCost) {
    all.push({
      kind: "note",
      id: "line",
      content: (
        <>
          {host ? (
            <span className="flex min-w-0 items-center gap-1.5" data-thread-host={host.environmentId}>
              <HostGlyph environmentId={host.environmentId} />
              <span className="truncate">{host.name}</span>
            </span>
          ) : null}
          {shownCost ? <span className="ms-auto tabular-nums">{shownCost}</span> : null}
        </>
      ),
    });
    all.push({ kind: "sep" });
  }
  all.push(...rows, { kind: "sep" });
  if (running > 0) all.push({ kind: "item", id: "pause-all", label: "Pause all", icon: Pause, hint: String(running) });
  if (dev.shown) all.push({ kind: "item", id: "dev", label: "Dev server", icon: Globe, checked: dev.open });
  if (openTerminal) all.push({ kind: "item", id: "terminal", label: "Terminal", icon: Terminal, shortcut: shortcutFor("Terminal", "New") });
  if (recent.length > 0) {
    all.push({
      kind: "sub",
      id: "recent",
      label: "Recent threads",
      icon: Clock,
      items: recent.slice(0, RECENT_MAX).map((chip) => ({
        kind: "item",
        id: `recent:${chip.id}`,
        label: chipTitle(chip),
        icon: THREAD_GLYPHS[chip.thread.threadType ?? "chat"],
        hint: timeAgo(chip.updatedAt),
      })),
    });
  }
  if (archived.length > 0) all.push({ kind: "item", id: "archived", label: "Archived threads…", icon: ArchiveRestore });

  const pick = (id: string) => {
    if (id === "pause-all") onPauseAll().catch(() => loadToast().then((toast) => toast.error("Couldn't pause every thread")));
    else if (id === "dev") dev.onToggle();
    else if (id === "terminal") openTerminal?.();
    else if (id === "archived") setArchivedOpen(true);
    else if (id.startsWith("recent:")) onOpenRecent(id.slice("recent:".length));
    else onPick(id);
  };

  return (
    <div className="mr-1.5 flex shrink-0 items-center gap-0.5" data-tauri-drag-region="false">
      <RowsMenu
        label="Thread menu"
        tip={{ label: "Thread menu" }}
        trigger={
          <Button
            ref={anchor}
            variant="ghost"
            size="icon-sm"
            aria-label="Thread menu"
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal strokeWidth={1.5} />
          </Button>
        }
        rows={tidy(all)}
        onPick={pick}
        onOpenChange={(open) => open && onOpen?.()}
        className="w-60"
      />
      <Tip label="Panel" shortcut={shortcutFor("App", "Panel")} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Panel"
          aria-pressed={panel.open}
          onClick={panel.onToggle}
          className="text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/7 aria-pressed:text-foreground"
        >
          <PanelRight strokeWidth={1.5} />
        </Button>
      </Tip>
      <LazyPopover open={archivedOpen} onOpenChange={setArchivedOpen} anchor={anchor.current} align="end" className="w-72 gap-1 p-1" label="Archived threads">
        <ArchivedList
          archived={archived}
          onRestore={(id) => {
            if (archived.length === 1) setArchivedOpen(false);
            onRestore(id);
          }}
        />
      </LazyPopover>
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
            <ItemButton
              key={thread.id}
              size="xs"
              data-archived={thread.id}
              onClick={() => onRestore(thread.id)}
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
            </ItemButton>
          );
        })}
      </div>
    </>
  );
}
