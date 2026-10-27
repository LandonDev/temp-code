import { useCallback, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useSortable } from "../hooks/useSortable";
import type { FilePaneTab } from "../lib/layout";
import { MOD } from "../lib/platform";
import { terminalTabLabel } from "../lib/terminalTab";
import { Plus, Terminal, X } from "./icons";

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
  onAdd: () => void;
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
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      lockOverscroll(el);
    },
    [lockOverscroll],
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
        <TabsList
          ref={setList}
          variant="line"
          aria-label="Dock"
          className="scrollbar-none w-full min-w-0 justify-start gap-3 overflow-x-auto overscroll-none px-3 group-data-[orientation=horizontal]/tabs:h-full"
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
                className={`group relative flex h-full shrink-0 items-stretch ${sortable.draggingId === file.id ? "opacity-40" : ""} ${canDrag ? "touch-none" : ""}`}
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
                    <Terminal className="size-3.5" strokeWidth={1.75} />
                    <span className="max-w-48 truncate">{label}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{file.cwd}</TooltipContent>
                </Tooltip>
                {onClose ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-no-drag=""
                    aria-label={`Close ${label}`}
                    className={`absolute right-0 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${
                      file.id === active ? "opacity-100" : "opacity-0"
                    }`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onClose(file.id)}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {dev ? (
            <TabsTrigger value={DEV_TAB} data-dock-tab={DEV_TAB} className="flex-none">
              Dev servers
              {dev.count > 0 ? <span className="text-[11px] tabular-nums text-muted-foreground">{dev.count}</span> : null}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1 pr-2">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New terminal" onClick={onAdd} />}>
              <Plus />
            </TooltipTrigger>
            <TooltipContent>
              New terminal <Kbd>{MOD}`</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Hide panel" onClick={onHide} />}>
              <X />
            </TooltipTrigger>
            <TooltipContent>
              Hide panel <Kbd>{MOD}J</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}

const noop = () => {};
