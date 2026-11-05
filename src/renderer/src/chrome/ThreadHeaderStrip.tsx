import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { BackgroundWork } from "@server/shared/events";
import type { ThreadRules } from "@server/shared/rules";
import { Tip, TruncateTip } from "../components/tip";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { OVERFLOW_FADE, useOverflowEdges } from "../hooks/useOverflowEdges";
import { Input } from "../components/ui/input";
import { STATUS_ON_TIP, StatusMark } from "../components/ui/status";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { pendingApprovalForSession } from "../lib/approvalToast";
import { DRAG_THRESHOLD, setGrabbing, suppressTextSelection } from "../lib/drag";
import type { PaneEdge } from "../lib/layout";
import { paneDropFromPoint, setExternalPaneDrop } from "../lib/paneDrop";
import { focus } from "../stores/focus";
import { stripHold } from "../stores/header";
import { workspaceActions } from "../stores/workspaceActions";
import { useEnvironments } from "../lib/connection/status";
import { HARNESSES, UNTITLED_THREAD, sessionDisplayTitle, type HarnessId } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderChip, HeaderModel } from "../lib/threadHeaderModel";
import {
  hasPendingQuestion,
  marksAtRest,
  threadStatus,
  type ReadyMap,
  type StripThread,
  type ThreadStatus,
} from "../lib/threadStripModel";
import type { ActivityKind } from "../lib/session";
import { HostGlyph } from "./HostGlyph";
import { useHostsOffline } from "./hostOffline";
import { ChevronLeft, ChevronRight } from "./icons";
import { RowsContextMenu, type MenuRow } from "./menuRows";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { THREAD_LABELS } from "../surfaces/threads/threadTypes";
import { ThreadStatusMark } from "./TabIndicator";

/**
 * The deck title bar's thread strip: every root thread of the scope on two
 * rows. The live row holds the live threads in a stable order like a
 * browser's tabs, the shelf under it the settled ones freshest first, drawn
 * only while it has a chip; the thread on screen always has its chip and is
 * the active one, whichever row it sits on. A live chip is the type glyph
 * (the status mark in its 14px place while the thread works, waits or
 * fails), the title, "Master" when pinned and the host glyph (two or more
 * hosts); a shelf chip is smaller and quieter, with no status mark. The
 * hover label says the state in words.
 * A primary click selects (on release), a right-click opens the thread's
 * menu at the pointer, a double-click renames. Dragging a chip onto a pane's
 * edge opens that thread there, beside what is on screen. List rows take no
 * motion (DESIGN.md), so nothing here animates: a chip that settles while
 * the pointer is over the strip holds its place until the pointer goes or
 * the window loses focus.
 */

/** What a chip needs from a thread; a SessionMeta satisfies it. */
export type ChipThread = StripThread & {
  title: string;
  threadType: ThreadType | null;
  provider?: string;
  busySince?: number | null;
  activity?: string | null;
  statusDetail?: string | null;
  activityKind?: ActivityKind | null;
  tasks?: { done: number; total: number } | null;
  threadRules?: ThreadRules | null;
  failure?: { summary: string } | null;
  background?: BackgroundWork | null;
  /** The host the thread lives on: the glyph after the title, the offline tint. */
  environmentId?: string;
};

export type StripChip = HeaderChip<ChipThread>;

/** An archived thread of the selected project, recoverable from the thread menu. */
export type ArchivedThread = {
  id: string;
  title: string;
  type: ThreadType | null;
  updatedAt: number;
};

type ChipEvents = {
  planReady: ReadyMap;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** A chip's right-click: the thread's rows (lib/threadMenu.ts), one menu for the strip. */
  menu?: {
    rowsFor: (id: string | null) => readonly MenuRow[] | null;
    onPick: (pick: string, id: string | null) => void;
    onOpenChange: (open: boolean, id: string | null) => void;
  };
  activeRef: (el: HTMLDivElement | null) => void;
  /** The threads pinned as their project's master: the chip reads "Master" after the title. */
  masterIds?: ReadonlySet<string>;
};

/** Mouse wheels only emit deltaY; turn it sideways. Trackpad swipes keep
 *  native scrolling. */
function wheelToX(event: ReactWheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.currentTarget.scrollLeft += event.deltaY;
  }
}

/** The live row's overflow, measured by the title bar (TitleBar's `tabStripOverflow`). */
export type StripOverflow = { left: boolean; right: boolean };

export function ThreadHeaderStrip({
  model,
  onSelect,
  stripRef,
  overflow,
  onScrollBy,
  trailing,
  end,
  ...events
}: ChipEvents & {
  model: HeaderModel<ChipThread>;
  onSelect: (id: string) => void;
  /** The live row's scroller, for the title bar's overflow measurement. */
  stripRef: (el: HTMLDivElement | null) => void;
  /** Which ends of the live row hide chips: each gets a scroll arrow. */
  overflow?: StripOverflow;
  onScrollBy?: (direction: -1 | 1) => void;
  /** Sits right after the live row, outside it: the new-thread chooser. */
  trailing?: ReactNode;
  /** The title bar's right end: the plan chip, the agents cue, the thread menu and the panel toggle. */
  end?: ReactNode;
}) {
  const activeId = model.activeId;
  // The rows as published: a departed chip already holds its place in the
  // live row while the pointer is over the strip (`holdModel`, in the title bar).
  const live = model.live;
  const shelf = model.dormant;
  // The shelf folds in and out on `.collapsible-auto`; while it folds away
  // it keeps the chips it last showed.
  const [keptShelf, setKeptShelf] = useState(shelf);
  if (shelf.length > 0 && keptShelf !== shelf) setKeptShelf(shelf);
  const shownShelf = shelf.length > 0 ? shelf : keptShelf;
  useStripHoldRelease();
  // The shelf has no arrows: its cut edges fade over 24px instead (DESIGN "Shadow").
  const shelfEdges = useOverflowEdges<HTMLDivElement>();
  // Plain string keys: a cast inside a computed key stops the React Compiler from compiling the strip.
  const pad = {
    "--strip-pad-l": overflow?.left ? `${ARROW_ROOM_PX}px` : undefined,
    "--strip-pad-r": overflow?.right ? `${ARROW_ROOM_PX}px` : undefined,
  } as CSSProperties;
  // Each row's chips share one TooltipProvider inside its tablist, and the
  // end group has its own (ThreadHeader): a provider swaps from a fragment
  // to the primitive when tooltips warm, remounting what it wraps, so none
  // sits around a scroller.
  return (
    <RowsContextMenu
      label="Thread actions"
      rowsFor={events.menu?.rowsFor ?? (() => null)}
      onPick={(pick, id) => events.menu?.onPick(pick, id)}
      onOpenChange={(open, id) => events.menu?.onOpenChange(open, id)}
      disabled={!events.menu}
    >
      {/* One hold region over both rows: a chip that settles under the
          pointer keeps its place until the pointer leaves either. */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        data-strip-region
        onPointerEnter={() => stripHold.set(true)}
        onPointerLeave={() => stripHold.set(false)}
        onPointerCancel={() => stripHold.set(false)}
      >
        {/* The 40px live row: the chips, New thread and the end group share
            one centre, whatever else the title bar holds. */}
        <div className="flex h-10 min-w-0 items-center">
          {model.heading !== undefined ? (
            // The home has no strip: its chats are the column's Chats list,
            // so the row holds the thread on screen's title alone.
            model.heading ? <HomeHeading chip={model.heading} {...events} /> : null
          ) : (
          <div className="relative flex min-w-0 self-stretch" style={pad}>
            {overflow?.left && onScrollBy ? <ScrollArrow side="left" onClick={() => onScrollBy(-1)} /> : null}
            <div
              ref={stripRef}
              onWheel={wheelToX}
              role="tablist"
              aria-label="Threads"
              aria-orientation="horizontal"
              data-strip="live"
              data-tauri-drag-region="false"
              className="scrollbar-none flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-[var(--strip-pad-l,6px)] pr-[var(--strip-pad-r,6px)]"
            >
              <TooltipProvider>
                <ChipRow chips={live} activeId={activeId} onSelect={onSelect} {...events} />
              </TooltipProvider>
            </div>
            {overflow?.right && onScrollBy ? <ScrollArrow side="right" onClick={() => onScrollBy(1)} /> : null}
          </div>
          )}
          {model.heading !== undefined ? null : trailing}
          <div className="h-full min-w-1.5 flex-1" />
          {end}
        </div>
        <Collapsible open={shelf.length > 0}>
          <CollapsibleContent data-shelf-fold className="collapsible-auto">
            <div
              ref={shelfEdges}
              onWheel={wheelToX}
              role="tablist"
              aria-label="Settled threads"
              aria-orientation="horizontal"
              data-strip="shelf"
              data-tauri-drag-region="false"
              className={`scrollbar-none flex h-8 min-w-0 items-start gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5 pt-0.5 ${OVERFLOW_FADE}`}
            >
              <TooltipProvider>
                <ChipRow chips={shownShelf} activeId={activeId} onSelect={onSelect} shelf {...events} />
              </TooltipProvider>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </RowsContextMenu>
  );
}

/** The hold ends when the window loses focus, the page hides or the strip
 *  unmounts, as well as when the pointer leaves: a pointerleave never comes
 *  for a pointer that left with the window. */
function useStripHoldRelease(): void {
  useEffect(() => {
    const release = () => stripHold.set(false);
    const hidden = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, []);
}

/** One row's chips; only the active chip (else the row's first) takes Tab. */
function ChipRow({
  chips,
  activeId,
  onSelect,
  shelf = false,
  ...events
}: ChipEvents & {
  chips: readonly StripChip[];
  activeId: string | null;
  onSelect: (id: string) => void;
  shelf?: boolean;
}) {
  const focusable = chips.some((c) => c.id === activeId) ? activeId : chips[0]?.id;
  return chips.map((chip) => (
    <Chip
      key={chip.id}
      chip={chip}
      shelf={shelf}
      active={chip.id === activeId}
      focusable={chip.id === focusable}
      onSelect={onSelect}
      {...events}
    />
  ));
}

/** The room a scroll arrow takes from the live row's edge: 4px, the 28px
 *  arrow, 4px. The row pads that end by as much, so no chip sits under it. */
const ARROW_ROOM_PX = 36;

/** A scroll arrow over an end of the live row, on the title bar's own tone. */
function ScrollArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const label = side === "left" ? "Scroll threads left" : "Scroll threads right";
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <div className={`absolute inset-y-0 z-10 flex items-center bg-sidebar px-1 ${side === "left" ? "left-0" : "right-0"}`}>
      <Tip label={label} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-scroll-arrow={side}
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClick}
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon className="size-3.5" />
        </Button>
      </Tip>
    </div>
  );
}

export function chipTitle(chip: StripChip): string {
  const { title, provider } = chip.thread;
  const shown =
    provider && (HARNESSES as string[]).includes(provider)
      ? sessionDisplayTitle(title, provider as HarnessId)
      : title;
  return shown.trim() || UNTITLED_THREAD;
}

/** The chip's status in the one vocabulary: the tree's overrides, what it is about and its tally. */
export function chipStatus(chip: StripChip, planReady: ReadyMap): ThreadStatus {
  const t = chip.thread;
  // What a waiting thread waits on, when its transcript is loaded here.
  const session = t.status === "waiting" ? sessionStore.get(chip.id) : undefined;
  return threadStatus({
    status: t.status,
    treeHasPaused: t.treeHasPaused,
    treeCanContinue: t.treeCanContinue,
    activity: t.activity,
    statusDetail: t.statusDetail,
    tasks: t.tasks,
    failure: t.failure?.summary ?? null,
    planReady: !!planReady[chip.id],
    waitingOn: session ? (pendingApprovalForSession(session)?.tool ?? null) : null,
    asking: session ? hasPendingQuestion(session.blocks) : false,
    background: t.background ?? null,
  });
}

/** The chip's hover label: the title, then its status line (the word, what
 *  it is about, the tally), then the thread's type while the status mark
 *  stands in for its glyph, then the host's name when the chip shows its glyph. */
export function ChipHoverLabel({ title, status, host, type }: { title: string; status: ThreadStatus; host?: string | null; type?: string }) {
  return (
    <>
      <span>{title}</span>
      {/* The word in the tooltip's ink and weight, its detail the muted step. */}
      <ThreadStatusMark status={status} className={STATUS_ON_TIP} />
      {type ? <span className="text-background/70">{type}</span> : null}
      {host ? <span className="text-background/70">{host}</span> : null}
    </>
  );
}

/** The host's name for a chip's hover line, when the window knows two or more hosts. */
function useChipHost(environmentId: string | undefined): string | null {
  const environments = useEnvironments();
  if (!environmentId || environments.length < 2) return null;
  return environments.find((e) => e.id === environmentId)?.name ?? environmentId;
}

/** The roving focus along the row: arrows, Home and End move between chips. */
function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
  const step = keys[event.key];
  if (step === undefined) return;
  const tabs = [...(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
  const at = tabs.indexOf(event.currentTarget);
  const next = Number.isFinite(step) ? tabs[(at + step + tabs.length) % tabs.length] : step < 0 ? tabs[0] : tabs.at(-1);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function RenameInput({
  chip,
  shelf,
  onRename,
}: {
  chip: StripChip;
  shelf: boolean;
  onRename: (id: string, title: string) => void;
}) {
  const title = chip.thread.title;
  return (
    <Input
      autoFocus
      aria-label="Thread title"
      defaultValue={title}
      data-tauri-drag-region="false"
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = title;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => onRename(chip.id, event.target.value.trim())}
      className={shelf ? "h-6 w-40 shrink-0 px-2 text-xs" : "h-7 w-44 shrink-0 px-3 text-[13px]"}
    />
  );
}

/**
 * A chip's primary press: a release before the pointer moves `DRAG_THRESHOLD`
 * is a click and selects; past it the chip drags its thread over the panes,
 * showing where it would land, and a release over a pane drops it there.
 * Escape, a cancelled pointer, the window losing focus or a release outside
 * every pane end the drag with nothing done.
 */
function useChipDrag(id: string, select: () => void) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Only the primary button without Control: a right press (or a
    // Control-click on the Mac) is the chip's menu.
    if (event.button !== 0 || event.ctrlKey) return;
    const startX = event.clientX;
    const startY = event.clientY;
    // The chip holds the pointer, so a drag over an html_render iframe keeps
    // its moves and its release, which the frame's document would swallow.
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    let restoreSelection: (() => void) | null = null;

    const move = (ev: PointerEvent) => {
      if (!restoreSelection) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        restoreSelection = suppressTextSelection();
        setGrabbing(true);
        setDragging(true);
      }
      const over = paneDropFromPoint(ev.clientX, ev.clientY);
      setExternalPaneDrop({ fromId: id, overId: over?.id ?? null, edge: over?.edge ?? "left" });
    };
    const up = (ev: PointerEvent) => {
      if (!restoreSelection) {
        end();
        select();
        return;
      }
      const over = paneDropFromPoint(ev.clientX, ev.clientY);
      end();
      if (over && over.id !== id) dropChip(id, over.id, over.edge);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end();
    };
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", end);
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      if (!restoreSelection) return;
      restoreSelection();
      restoreSelection = null;
      setGrabbing(false);
      setDragging(false);
      setExternalPaneDrop(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", end);
  };
  return { dragging, onPointerDown };
}

/** The dropped thread joins the open sessions as App's own open does, and
 *  its composer takes the keyboard from the dock or an editor. */
function dropChip(id: string, paneId: string, edge: PaneEdge): void {
  workspaceActions.dropThread(id, paneId, edge);
  const session = sessionStore.get(id);
  if (session && !sessionStore.isOpen(id)) sessionStore.mutate((open) => [...open, session]);
  focus.projectTerminal(false);
  focus.composer(true);
  // A pane already on the page whose composer held the flag never hears it
  // again: give its field the caret, off the chip.
  document.querySelector<HTMLElement>(`[data-session-drop="${id}"] [data-composer-input]`)?.focus();
}

/**
 * The home's title: the thread on screen in 13px medium foreground where the
 * live row's first chip would start, outside the window's drag region only
 * over its words. A double-click renames it in place and a right-click opens
 * the thread's menu, as on a chip; nothing else is drawn, since the column's
 * Chats list already says its type and state.
 */
function HomeHeading({ chip, ...events }: { chip: StripChip } & ChipEvents) {
  if (events.renamingId === chip.id)
    return (
      <div className="flex min-w-0 pl-1.5">
        <RenameInput chip={chip} shelf={false} onRename={events.onRename} />
      </div>
    );
  const title = chipTitle(chip);
  return (
    <div className="flex min-w-0 pl-1.5">
      <TruncateTip text={title} side="bottom">
      <h1
        data-home-heading
        data-menu-id={chip.id}
        data-tauri-drag-region="false"
        onDoubleClick={() => events.onStartRename(chip.id)}
        className="min-w-0 truncate px-3 text-[13px] leading-5 font-medium text-foreground"
      >
        {title}
      </h1>
      </TruncateTip>
    </div>
  );
}

const LIVE_CHIP = "h-7 gap-2 px-3 text-[13px] data-unread:font-medium data-unread:text-foreground";
/** A chip's title; its ::after is the bold copy that holds the width. */
const CHIP_TITLE =
  "min-w-0 truncate after:invisible after:block after:h-0 after:overflow-hidden after:font-medium after:content-[attr(data-text)]";
/** A shelf chip: 24px, 8px padding, 6px from glyph to title, 12px muted type. */
const SHELF_CHIP = "h-6 gap-1.5 px-2 text-xs";

function Chip({
  chip,
  shelf,
  active,
  focusable,
  onSelect,
  ...events
}: {
  chip: StripChip;
  shelf: boolean;
  active: boolean;
  focusable: boolean;
  onSelect: (id: string) => void;
} & ChipEvents) {
  // An active chip selects too: its pane may not be the focused one (a file
  // pane beside it, a subagent), and selecting focuses it.
  const drag = useChipDrag(chip.id, () => onSelect(chip.id));
  const environmentId = chip.thread.environmentId;
  const offline = useHostsOffline([environmentId]);
  const host = useChipHost(environmentId);
  if (events.renamingId === chip.id) return <RenameInput chip={chip} shelf={shelf} onRename={events.onRename} />;
  const status = chipStatus(chip, events.planReady);
  const title = chipTitle(chip);
  const unread = !shelf && !active && chip.unread;
  // While it works, waits or fails, a live chip's status mark takes the type
  // glyph's 14px place, as a browser tab's favicon turns into a spinner; at
  // rest the glyph is back. Nothing else in the chip moves.
  const marked = !shelf && marksAtRest(status.state);
  return (
    <div
      ref={active ? events.activeRef : undefined}
      className={`shrink-0${offline ? " opacity-50" : ""}`}
      data-menu-id={chip.id}
      data-host-offline={offline || undefined}
      onDoubleClick={() => events.onStartRename(chip.id)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              role="tab"
              aria-selected={active}
              tabIndex={focusable ? 0 : -1}
              data-unread={unread || undefined}
              data-dragging={drag.dragging || undefined}
              data-shelf={shelf || undefined}
              onPointerDown={drag.onPointerDown}
              onClick={(event) => {
                // A pointer selects on release (useChipDrag); this is Enter and Space.
                if (event.detail === 0) onSelect(chip.id);
              }}
              onKeyDown={moveFocus}
              className={`${shelf ? SHELF_CHIP : LIVE_CHIP} min-w-0 justify-start rounded-md font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground aria-selected:transition-none data-dragging:opacity-50`}
            />
          }
        >
          {shelf ? (
            <TypeGlyph type={chip.thread.threadType} className="size-3" />
          ) : (
            <span data-chip-glyph className="flex size-3.5 shrink-0 items-center justify-center">
              {marked ? <StatusMark state={status.state} word={false} /> : <TypeGlyph type={chip.thread.threadType} className="size-3.5" />}
            </span>
          )}
          {/* An unseen medium-weight copy of the title (its ::after, no height)
              holds the bold width, so unread never widens the chip. */}
          {/* The cap is the title's in both rows (224px live, 160px on the
              shelf), so Master and the host glyph never take its room. */}
          <span data-chip-title data-text={title} className={`${CHIP_TITLE} ${shelf ? "max-w-40" : "max-w-56"}`}>
            {title}
          </span>
          {events.masterIds?.has(chip.id) ? (
            <span className="shrink-0 font-normal text-muted-foreground" data-master-word>
              Master
            </span>
          ) : null}
          {host ? <HostGlyph environmentId={environmentId} bare /> : null}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex-col items-start gap-0.5 text-left">
          <ChipHoverLabel title={title} status={status} host={host} type={marked ? THREAD_LABELS[chip.thread.threadType ?? "chat"] : undefined} />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
