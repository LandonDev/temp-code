import { useRef, useState } from "react";
import { loadToast } from "../components/ui/toaster";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { NO_ROOM_LABEL } from "../lib/rightPanel";
import { shortcutFor } from "../lib/settings";
import { LazyPopover, RowsMenu, tidy, type MenuRow } from "./menuRows";
import { HostGlyph } from "./HostGlyph";
import { dialogsChunk } from "../surfaces/chunks";
import { ArchiveRestore, Clock, MoreHorizontal, PanelRight, Pause, Terminal } from "./icons";
import { chipTitle, type ArchivedThread, type StripChip } from "./ThreadHeaderStrip";

/** The Recent and Archived lists' body, out of the first paint (chrome/ThreadListPopover.tsx). */
const ThreadListPopover = dialogsChunk.surface("ThreadListPopover");

/**
 * The title bar's right end in deck layout: the ⋯ thread menu, then the
 * panel toggle (last, nearest the panel it opens). The menu holds a quiet
 * line naming the host and the thread's cost, the active thread's own rows
 * (lib/threadMenu.ts, the list its chip's right-click shows), and the
 * project's rows: Pause all, Terminal, Recent threads… and Archived
 * threads…, each a popover listing every one of them.
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
  terminal: { onShow?: () => void; onNew?: () => void; active: boolean };
  /** Every settled root of the strip's scope, freshest first. */
  recent: readonly StripChip[];
  onOpenRecent: (id: string) => void;
  archived: readonly ArchivedThread[];
  onRestore: (id: string) => void;
  /** `room` false: the thread's row is too narrow to draw the panel. */
  panel: { open: boolean; room?: boolean; onToggle: () => void };
};

export function ThreadMenu({
  host,
  cost,
  rows,
  onPick,
  onOpen,
  running,
  onPauseAll,
  terminal,
  recent,
  onOpenRecent,
  archived,
  onRestore,
  panel,
}: ThreadMenuProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [list, setList] = useState<"recent" | "archived" | null>(null);
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
  if (openTerminal) all.push({ kind: "item", id: "terminal", label: "Terminal", icon: Terminal, shortcut: shortcutFor("Terminal", "New") });
  if (recent.length > 0) all.push({ kind: "item", id: "recent", label: "Recent threads…", icon: Clock });
  if (archived.length > 0) all.push({ kind: "item", id: "archived", label: "Archived threads…", icon: ArchiveRestore });

  const pick = (id: string) => {
    if (id === "pause-all") onPauseAll().catch(() => loadToast().then((toast) => toast.error("Couldn't pause every thread")));
    else if (id === "terminal") openTerminal?.();
    else if (id === "recent" || id === "archived") setList(id);
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
            <MoreHorizontal />
          </Button>
        }
        rows={tidy(all)}
        onPick={pick}
        onOpenChange={(open) => {
          if (!open) return;
          // The thread lists' body rides the dialogs chunk: warm it with the menu.
          dialogsChunk.preload();
          onOpen?.();
        }}
        className="w-60"
      />
      {/* No room keeps the reason on hover, so the button stays hoverable (aria-disabled, not disabled). */}
      <Tip
        label={panel.room === false ? NO_ROOM_LABEL : "Panel"}
        shortcut={panel.room === false ? undefined : shortcutFor("App", "Panel")}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Panel"
          aria-pressed={panel.room !== false && panel.open}
          aria-disabled={panel.room === false || undefined}
          onClick={panel.room === false ? undefined : panel.onToggle}
          className="text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
        >
          <PanelRight />
        </Button>
      </Tip>
      <LazyPopover
        open={list !== null}
        onOpenChange={(open) => !open && setList(null)}
        anchor={anchor.current}
        finalFocus={anchor}
        align="end"
        className="w-72 gap-1 p-1"
        label={list === "archived" ? "Archived threads" : "Recent threads"}
      >
        {list === null ? null : list === "archived" ? (
          <ThreadListPopover
            heading="Archived"
            threads={archived}
            restore
            onPick={(id) => {
              if (archived.length === 1) setList(null);
              onRestore(id);
            }}
          />
        ) : (
          <ThreadListPopover
            heading="Recent"
            threads={recent.map((chip) => ({ id: chip.id, title: chipTitle(chip), type: chip.thread.threadType ?? null, updatedAt: chip.updatedAt }))}
            onPick={(id) => {
              setList(null);
              onOpenRecent(id);
            }}
          />
        )}
      </LazyPopover>
    </div>
  );
}
