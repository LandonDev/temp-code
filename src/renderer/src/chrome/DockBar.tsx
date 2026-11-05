import { OVERFLOW_FADE, useOverflowEdges } from "../hooks/useOverflowEdges";
import { useCallback, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { reveal } from "../components/ui/reveal";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useSortable } from "../hooks/useSortable";
import type { FilePaneTab } from "../lib/layout";
import { shortcutFor } from "../lib/settings";
import { terminalTabLabel } from "../lib/terminalTab";
import { PanelBottomClose, Plus, Terminal, X } from "./icons";

/** The Dev servers tab's value in the bar. */
export const DEV_TAB = "dev";

export type DockBarProps = {
  terminals: FilePaneTab[];
  /** A terminal id, or DEV_TAB. */
  active: string;
  /** null: no Dev servers tab. */
  dev: { count: number } | null;
  onSelect: (id: string) => void;
  onSelectDev: () => void;
  /** Absent: the tabs have no close. */
  onClose?: (id: string) => void;
  /** Absent: the tabs do not drag. */
  onReorder?: (ids: string[]) => void;
  /** Absent: no New terminal (the page at /ui has no terminal). */
  onAdd?: () => void;
  onHide: () => void;
};

/**
 * The bottom dock's one bar, whichever occupant shows: the project's
 * terminals and the Dev servers tab as line tabs, then New terminal and
 * Hide. Presentational; switching is instant (the dock is toggled from the
 * keyboard many times a day).
 */
export function DockBar({ terminals, active, dev, onSelect, onSelectDev, onClose, onReorder, onAdd, onHide }: DockBarProps) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const edges = useOverflowEdges<HTMLDivElement>();
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      lockOverscroll(el);
      edges(el);
    },
    [lockOverscroll, edges],
  );
  const ids = terminals.map((file) => file.id);
  const sortable = useSortable(ids, onReorder ?? noop);
  const canDrag = Boolean(onReorder) && terminals.length > 1;

  useLayoutEffect(() => {
    if (sortable.draggingId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-dock-tab="${CSS.escape(active)}"]`);
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [active, sortable.draggingId]);

  return (
    <div data-dock-bar="" className="flex h-9 min-w-0 shrink-0 items-stretch border-b border-border">
      <Tabs
        value={active}
        onValueChange={(value) => (value === DEV_TAB ? onSelectDev() : onSelect(String(value)))}
        className="min-w-0 flex-1 gap-0"
      >
        {/* The line variant zeroes a list's padding, so the 8px is stated on that
            variant: a tab's label (4px into its trigger) starts on the terminal's 12px. */}
        <TabsList
          ref={setList}
          variant="line"
          aria-label="Dock"
          className={`scrollbar-none w-full min-w-0 justify-start gap-3 overflow-x-auto overscroll-none data-[variant=line]:px-2 group-data-[orientation=horizontal]/tabs:h-full ${OVERFLOW_FADE}`}
        >
          {terminals.map((file, index) => {
            const label = terminalTabLabel(file);
            const closable = Boolean(onClose);
            const dropBefore = sortable.toIndex === index && sortable.fromIndex !== null && sortable.toIndex < sortable.fromIndex;
            const dropAfter = sortable.toIndex === index && sortable.fromIndex !== null && sortable.toIndex > sortable.fromIndex;
            return (
              <div
                key={file.id}
                data-dock-tab={file.id}
                ref={(el) => sortable.setItemRef(file.id, el)}
                className={`group/dock-tab relative flex h-full shrink-0 items-stretch ${sortable.draggingId === file.id ? "z-10" : ""} ${canDrag ? "touch-none" : ""}`}
                onPointerDown={(event) => {
                  if (!canDrag || event.button !== 0) return;
                  if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
                  sortable.onItemPointerDown(file.id, event);
                }}
                onMouseDown={(event) => {
                  if (event.button === 1 && closable) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || !onClose) return;
                  event.preventDefault();
                  onClose(file.id);
                }}
              >
                {dropBefore ? <span className="pointer-events-none absolute inset-y-2 -left-2 z-10 w-0.5 rounded-full bg-accent" /> : null}
                {dropAfter ? <span className="pointer-events-none absolute inset-y-2 -right-2 z-10 w-0.5 rounded-full bg-accent" /> : null}
                <Tooltip>
                  <TooltipTrigger
                    render={<TabsTrigger value={file.id} className={`flex-none gap-2 ${closable ? "group-data-[variant=line]/tabs-list:pr-6" : ""}`} />}
                  >
                    <Terminal className="size-3.5" />
                    <span className="max-w-48 truncate">{label}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{file.cwd}</TooltipContent>
                </Tooltip>
                {onClose ? (
                  // The active tab's close stays; another tab's waits on the shared hover reveal.
                  <span className={`absolute right-0 top-1/2 flex -translate-y-1/2 ${file.id === active ? "" : reveal("dock-tab", { row: true })}`}>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      data-no-drag=""
                      aria-label={`Close ${label}`}
                      className="text-muted-foreground hover:text-foreground"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => onClose(file.id)}
                    >
                      <X />
                    </Button>
                  </span>
                ) : null}
              </div>
            );
          })}
          {dev ? (
            <TabsTrigger value={DEV_TAB} data-dock-tab={DEV_TAB} className="flex-none gap-1">
              Dev servers
              {dev.count > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{dev.count}</span> : null}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1 pr-2">
          {onAdd ? (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New terminal" onClick={onAdd} />}>
                <Plus />
              </TooltipTrigger>
              <TooltipContent>
                New terminal <Kbd>{shortcutFor("Terminal", "New")}</Kbd>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {/* The dock's own glyph and name: a tab's close is the X beside it. */}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Hide dock" onClick={onHide} />}>
              <PanelBottomClose />
            </TooltipTrigger>
            <TooltipContent>
              Hide dock <Kbd>{shortcutFor("Terminal", "Show or Hide")}</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}

const noop = () => {};
