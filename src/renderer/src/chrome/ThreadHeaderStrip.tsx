import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ThreadRules } from "@server/shared/rules";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { Input } from "../components/ui/input";
import { STATUS_WORD, StatusMark, threadStateOf, type ThreadState } from "../components/ui/status";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { pendingApprovalForSession } from "../lib/approvalToast";
import { HARNESSES, sessionDisplayTitle, type HarnessId } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import type { ThreadType } from "../lib/tcserver/types";
import { holdDepartures, type HeaderChip, type HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap, StripThread } from "../lib/threadStripModel";
import type { ActivityKind } from "../lib/session";
import { THREAD_GLYPHS } from "../surfaces/threads/bits";

/**
 * The deck title bar's thread strip: the selected project's live root
 * threads as one row of chips, in a stable order like a browser's tabs (the
 * thread on screen always has its chip; settled ones are "Recent threads"
 * in the thread menu). A chip is the type glyph, the title, "Master" when
 * pinned and the status glyph (none for a settled thread); the hover label
 * says the state in words.
 * A primary press selects, a right-click opens the thread's menu at the
 * pointer, a double-click renames. List rows take no motion (DESIGN.md), so
 * nothing here animates: a chip that leaves while the pointer is over the
 * strip holds its place until the pointer goes.
 */

/** What a chip needs from a thread; a SessionMeta satisfies it. */
export type ChipThread = StripThread & {
  title: string;
  threadType: ThreadType | null;
  provider?: string;
  busySince?: number | null;
  activity?: string | null;
  activityKind?: ActivityKind | null;
  tasks?: { done: number; total: number } | null;
  threadRules?: ThreadRules | null;
  failure?: { summary: string } | null;
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
  /** The right-click, before the menu opens: load what its rows need. */
  onContextMenu: (chip: StripChip, event: ReactMouseEvent<HTMLElement>) => void;
  /** The thread's menu rows, rendered inside the chip's ContextMenu. */
  menu?: (chip: StripChip, close: () => void) => ReactNode;
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

export function ThreadHeaderStrip({
  model,
  onSelect,
  stripRef,
  trailing,
  end,
  ...events
}: ChipEvents & {
  model: HeaderModel<ChipThread>;
  onSelect: (id: string) => void;
  /** The row's scroller, for the title bar's overflow chevrons. */
  stripRef: (el: HTMLDivElement | null) => void;
  /** Sits after the chips: the new-thread chooser. */
  trailing?: ReactNode;
  /** The title bar's right end: the thread menu and the panel toggle. */
  end?: ReactNode;
}) {
  const activeId = model.activeId;
  const held = useHeldChips(model.live);
  const focusable = held.chips.some((c) => c.id === activeId) ? activeId : held.chips[0]?.id;
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <TooltipProvider>
        <div
          ref={stripRef}
          onWheel={wheelToX}
          onPointerEnter={held.hold}
          onPointerLeave={held.release}
          role="tablist"
          aria-label="Threads"
          aria-orientation="horizontal"
          data-strip="live"
          data-tauri-drag-region="false"
          className="scrollbar-none flex h-10 min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-[var(--strip-pad-l,6px)] pr-[var(--strip-pad-r,6px)]"
        >
          {held.chips.map((chip) => (
            <Chip
              key={chip.id}
              chip={chip}
              active={chip.id === activeId}
              focusable={chip.id === focusable}
              onSelect={onSelect}
              {...events}
            />
          ))}
          {trailing}
        </div>
      </TooltipProvider>
      <div className="h-full min-w-1.5 flex-1" />
      {end}
    </div>
  );
}

/**
 * The chips as drawn: while the pointer is over the strip a chip whose thread
 * left the row stays in its place (a click never shifts the row under the
 * cursor); when the pointer leaves, the departures go.
 */
function useHeldChips(next: StripChip[]): { chips: StripChip[]; hold: () => void; release: () => void } {
  const [holding, setHolding] = useState(false);
  const shown = useRef<StripChip[]>(next);
  const ids = holdDepartures(
    shown.current.map((chip) => chip.id),
    next.map((chip) => chip.id),
    holding,
  );
  let chips = next;
  if (ids.length !== next.length) {
    const byId = new Map(shown.current.map((chip) => [chip.id, chip]));
    for (const chip of next) byId.set(chip.id, chip);
    chips = ids.map((id) => byId.get(id)!);
  }
  shown.current = chips;
  return { chips, hold: () => setHolding(true), release: () => setHolding(false) };
}

export function chipTitle(chip: StripChip): string {
  const { title, provider } = chip.thread;
  const shown =
    provider && (HARNESSES as string[]).includes(provider)
      ? sessionDisplayTitle(title, provider as HarnessId)
      : title;
  return shown.trim() || "New session";
}

/** States a chip leaves unmarked: a settled thread says nothing at rest
 *  (its hover label still names the state). */
const QUIET: ReadonlySet<ThreadState> = new Set(["idle", "done"]);

/** The chip's state in the one vocabulary (components/ui/status.tsx). */
export function chipState(chip: StripChip, planReady: ReadyMap): ThreadState {
  return threadStateOf(chip.status, { planReady: !!planReady[chip.id] });
}

/** What the state is about, for the hover label's second line: the tally, the
 *  activity ("typecheck", "approve Bash") or the failure's verdict. */
export function chipDetail(chip: StripChip, state: ThreadState, waitingOn?: string | null): string | null {
  const t = chip.thread;
  if (state === "failed") return t.failure?.summary ?? null;
  if (state === "waiting" && waitingOn) return waitingOn;
  if (state === "idle" || state === "done" || state === "plan-ready") return null;
  if (t.tasks && state === "working") return `${t.tasks.done}/${t.tasks.total}`;
  const activity = t.activity?.trim();
  if (!activity) return null;
  // The host's queued line repeats the word ("Queued · 3rd in line").
  const word = STATUS_WORD[state];
  return activity.startsWith(word) ? activity.slice(word.length).replace(/^[\s·:—-]+/, "") || null : activity;
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

function RenameInput({ chip, onRename }: { chip: StripChip; onRename: (id: string, title: string) => void }) {
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
      className="h-7 w-44 shrink-0 px-3 text-[13px]"
    />
  );
}

function Chip({
  chip,
  active,
  focusable,
  onSelect,
  ...events
}: { chip: StripChip; active: boolean; focusable: boolean; onSelect: (id: string) => void } & ChipEvents) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (events.renamingId === chip.id) return <RenameInput chip={chip} onRename={events.onRename} />;
  const state = chipState(chip, events.planReady);
  // What a waiting thread waits on: its pending approval ("Bash: bun test"), when loaded here.
  const session = state === "waiting" ? sessionStore.get(chip.id) : undefined;
  const detail = chipDetail(chip, state, session ? pendingApprovalForSession(session)?.label : null);
  const title = chipTitle(chip);
  const unread = !active && chip.unread;
  const Glyph = THREAD_GLYPHS[chip.thread.threadType ?? "chat"];
  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        ref={active ? events.activeRef : undefined}
        className="shrink-0"
        onContextMenu={(event) => events.onContextMenu(chip, event)}
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
                onPointerDown={(event) => {
                  // Only the primary button without Control selects: a right
                  // press (or a Control-click on the Mac) is the chip's menu.
                  if (event.button !== 0 || event.ctrlKey) return;
                  if (!active) onSelect(chip.id);
                }}
                onClick={(event) => {
                  // Pointer presses selected on down; this is Enter and Space.
                  if (event.detail === 0 && !active) onSelect(chip.id);
                }}
                onKeyDown={moveFocus}
                className="h-7 max-w-56 min-w-0 justify-start gap-2 rounded-md px-3 text-[13px] font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent aria-selected:bg-muted aria-selected:text-foreground aria-selected:transition-none data-unread:font-medium data-unread:text-foreground"
              />
            }
          >
            <Glyph className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 truncate">{title}</span>
            {events.masterIds?.has(chip.id) ? (
              <span className="shrink-0 font-normal text-muted-foreground" data-master-word>
                Master
              </span>
            ) : null}
            {QUIET.has(state) ? null : <StatusMark state={state} word={false} />}
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex-col items-start gap-0.5 text-left">
            <span>{title}</span>
            <span className="flex gap-2 font-normal text-background/70">
              <span>{STATUS_WORD[state]}</span>
              {detail ? <span className="min-w-0 truncate">{detail}</span> : null}
            </span>
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      {menuOpen && events.menu ? (
        <ContextMenuContent aria-label="Thread actions">{events.menu(chip, () => setMenuOpen(false))}</ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
