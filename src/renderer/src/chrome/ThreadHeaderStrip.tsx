import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { SPRING_LAYOUT } from "../lib/ease";
import { HARNESSES, type HarnessId } from "../lib/session";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderChip, HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap, StripThread } from "../lib/threadStripModel";
import { Tabs, TabsTrigger } from "../motion";
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TINTS, timeAgo } from "../surfaces/threads/bits";
import { HarnessIcon } from "./HarnessIcon";
import { Archive, ArchiveRestore, Search } from "./icons";
import { Popover } from "./Popover";
import { TabIndicator, type TabThread } from "./TabIndicator";

/**
 * temp-code's ThreadStrip on MonoCode's title bar: the selected project's
 * root threads as soft chips, live ones on the top row, the dormant shelf a
 * line below, each row freshest first. A chip is a thread, open in a tab
 * or not; nothing here closes one. Selection commits on pointer-down and
 * the active wash glides between chips; chips scale in and slide closed on
 * archive. Right-click for the thread's menu, double-click to rename, the
 * shelf at the row's end brings archived threads back.
 */

/** What a chip needs from a thread; a SessionMeta satisfies it. */
export type ChipThread = StripThread & {
  title: string;
  threadType: ThreadType | null;
  provider?: string;
  busySince?: number | null;
  frozenActiveElapsed?: number | null;
  treeFrozenActiveElapsed?: number | null;
  activity?: string | null;
  activityKind?: TabThread["activityKind"];
  tasks?: { done: number; total: number } | null;
};

export type StripChip = HeaderChip<ChipThread>;

/** An archived thread of the selected project, recoverable from the shelf. */
export type ArchivedThread = {
  id: string;
  title: string;
  type: ThreadType | null;
  updatedAt: number;
};

type ChipEvents = {
  now: number;
  planReady: ReadyMap;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onContextMenu: (chip: StripChip, event: ReactMouseEvent<HTMLDivElement>) => void;
  activeRef: (el: HTMLDivElement | null) => void;
};

/** Mouse wheels only emit deltaY; turn it sideways. Trackpad swipes keep
 *  native scrolling. */
function wheelToX(event: ReactWheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.currentTarget.scrollLeft += event.deltaY;
  }
}

const TONE_WASH: Record<NonNullable<StripChip["tone"]>, string> = {
  warning: "bg-warning/10 hover:bg-warning/15",
  danger: "bg-danger/10 hover:bg-danger/15",
  info: "bg-info/10 hover:bg-info/15",
};

export function ThreadHeaderStrip({
  model,
  onSelect,
  archived,
  onRestore,
  stripRef,
  trailing,
  ...events
}: ChipEvents & {
  model: HeaderModel<ChipThread>;
  onSelect: (id: string) => void;
  archived: ArchivedThread[];
  onRestore: (sessionId: string) => void;
  /** The live row's scroller, for the title bar's overflow chevrons. */
  stripRef: (el: HTMLDivElement | null) => void;
  /** Sits after the live chips: the new-thread chooser. */
  trailing?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const activeId = model.activeId ?? "";
  const row = (chips: StripChip[], shelf: boolean) => (
    <AnimatePresence initial={false} mode="popLayout">
      {chips.map((chip) => (
        <motion.div
          key={chip.id}
          layout
          initial={reduce ? false : { opacity: 0, scale: shelf ? 0.92 : 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduce ? undefined : { opacity: 0, scale: shelf ? 0.92 : 0.9 }}
          transition={SPRING_LAYOUT}
          className="shrink-0"
          data-tauri-drag-region="false"
          ref={chip.id === activeId ? events.activeRef : undefined}
          onDoubleClick={() => events.onStartRename(chip.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            events.onContextMenu(chip, event);
          }}
        >
          <Chip chip={chip} shelf={shelf} active={chip.id === activeId} {...events} />
        </motion.div>
      ))}
    </AnimatePresence>
  );

  return (
    <Tabs
      variant="soft"
      value={activeId}
      onValueChange={onSelect}
      className="flex min-w-0 flex-1 flex-col"
    >
      <div className="flex h-10 min-w-0 items-center">
        <motion.div
          layoutScroll
          ref={stripRef}
          onWheel={wheelToX}
          role="tablist"
          data-strip="live"
          className="scrollbar-none flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5"
        >
          {row(model.live, false)}
          {trailing}
        </motion.div>
        <div className="min-w-1.5 flex-1" />
        <ArchivedShelf archived={archived} onRestore={onRestore} />
      </div>
      {model.dormant.length > 0 ? (
        <motion.div
          layoutScroll
          onWheel={wheelToX}
          role="tablist"
          data-strip="shelf"
          className="scrollbar-none flex h-7 min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5 pb-1"
        >
          {row(model.dormant, true)}
        </motion.div>
      ) : null}
    </Tabs>
  );
}

function chipTitle(chip: StripChip): string {
  return chip.thread.title.trim() || "New session";
}

function chipTooltip(chip: StripChip): string {
  const type = chip.thread.threadType;
  const kind = type ? THREAD_LABELS[type] : "Thread";
  return `${chipTitle(chip)} · ${kind}`;
}

function tabThreadOf(chip: StripChip, planReady: ReadyMap, active: boolean): TabThread {
  const t = chip.thread;
  return {
    type: t.threadType,
    status: chip.status,
    unread: !active && chip.unread,
    since: t.busySince ?? t.updatedAt,
    activity: t.activity ?? null,
    activityKind: t.activityKind ?? null,
    tasks: t.tasks ? { done: t.tasks.done, total: t.tasks.total } : null,
    planReady: !!planReady[chip.id],
    frozenElapsed: t.treeFrozenActiveElapsed ?? t.frozenActiveElapsed ?? null,
  };
}

function ChipGlyph({ chip, dimmed, size }: { chip: StripChip; dimmed: boolean; size: string }) {
  const type = chip.thread.threadType;
  const fade = dimmed ? "opacity-60 grayscale" : "opacity-80";
  if (type && type !== "chat") {
    const Glyph = THREAD_GLYPHS[type];
    return <Glyph className={`${size} shrink-0 ${THREAD_TINTS[type]} ${fade}`} strokeWidth={1.75} />;
  }
  const provider = chip.thread.provider;
  if (provider && (HARNESSES as string[]).includes(provider)) {
    return (
      <span className={`flex shrink-0 items-center ${dimmed ? "opacity-60 grayscale" : ""}`}>
        <HarnessIcon harness={provider as HarnessId} className={size} />
      </span>
    );
  }
  const Glyph = THREAD_GLYPHS.chat;
  return <Glyph className={`${size} shrink-0 ${THREAD_TINTS.chat} ${fade}`} strokeWidth={1.75} />;
}

function RenameInput({
  chip,
  className,
  onRename,
}: {
  chip: StripChip;
  className: string;
  onRename: (id: string, title: string) => void;
}) {
  const title = chip.thread.title;
  return (
    <input
      autoFocus
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
      className={`rounded-md bg-content/10 text-content outline-none ${className}`}
    />
  );
}

function Chip({
  chip,
  shelf,
  active,
  ...events
}: { chip: StripChip; shelf: boolean; active: boolean } & ChipEvents) {
  if (events.renamingId === chip.id) {
    return (
      <RenameInput
        chip={chip}
        onRename={events.onRename}
        className={shelf ? "h-5 w-36 px-1.5 text-[11.5px]" : "h-[26px] w-44 px-2.5 text-[13px]"}
      />
    );
  }
  const thread = tabThreadOf(chip, events.planReady, active);
  const busy = chip.status === "running" || chip.status === "starting" || chip.status === "paused";
  const tooltip = chipTooltip(chip);
  return (
    <span
      title={tooltip}
      className={`block rounded-md ${chip.tone ? TONE_WASH[chip.tone] : ""} ${
        shelf && !active ? "opacity-70 hover:opacity-100" : ""
      }`}
    >
      <TabsTrigger
        value={chip.id}
        className={
          shelf
            ? "h-5 max-w-36 min-w-0 justify-start gap-1 px-1.5 py-0 text-[11.5px] leading-none"
            : "h-[26px] max-w-56 min-w-0 justify-start gap-1.5 px-2.5 py-0 text-[13px] leading-none"
        }
      >
        <ChipGlyph chip={chip} dimmed={!active} size={shelf ? "size-3" : "size-[13px]"} />
        <span
          className={`min-w-0 truncate ${busy && !shelf ? "max-w-32" : ""} ${
            thread.unread ? "font-medium text-content" : ""
          }`}
        >
          {chipTitle(chip)}
        </span>
        <TabIndicator thread={thread} now={events.now} />
      </TabsTrigger>
    </span>
  );
}

/** Recover archived threads: restore puts the chip back and opens it.
 *  Grows a search field once the list holds more than a screenful. */
function ArchivedShelf({
  archived,
  onRestore,
}: {
  archived: ArchivedThread[];
  onRestore: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const button = useRef<HTMLButtonElement | null>(null);
  const reduce = useReducedMotion();
  if (archived.length === 0) return null;

  const q = query.trim().toLowerCase();
  const shown = q ? archived.filter((t) => t.title.toLowerCase().includes(q)) : archived;
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const restore = (id: string) => {
    if (archived.length === 1) close();
    onRestore(id);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title="Archived threads"
        aria-label="Archived threads"
        aria-expanded={open}
        data-tauri-drag-region="false"
        onClick={() => (open ? close() : setOpen(true))}
        className={`mr-1.5 grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/5 hover:text-content ${
          open ? "bg-content/10 text-content" : ""
        }`}
      >
        <Archive className="size-3.5" strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="bottom"
          align="end"
          width={288}
          className="flex flex-col p-1"
          onDismiss={close}
          ignore="[aria-label='Archived threads']"
        >
          <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
            Archived · {archived.length}
          </div>
          {archived.length > 6 ? (
            <div className="relative px-1 pb-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-[calc(50%+2px)] text-content/40" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search…"
                className="h-7 w-full rounded-md bg-content/5 pr-2 pl-7 text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </div>
          ) : null}
          <div className="max-h-80 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-content/45">No matches.</p>
            ) : null}
            <AnimatePresence initial={false}>
              {shown.map((thread) => {
                const Glyph = THREAD_GLYPHS[thread.type ?? "chat"];
                return (
                  <motion.button
                    key={thread.id}
                    type="button"
                    layout
                    exit={reduce ? undefined : { opacity: 0, height: 0 }}
                    transition={SPRING_LAYOUT}
                    onClick={() => restore(thread.id)}
                    className="group/arch flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left hover:bg-content/5"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-content/10">
                      <Glyph
                        className={`size-3.5 opacity-80 ${THREAD_TINTS[thread.type ?? "chat"]}`}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-content">
                        {thread.title || "Untitled"}
                      </span>
                      <span className="block text-[11px] text-content/45">{timeAgo(thread.updatedAt)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-content/55 opacity-0 transition-opacity duration-150 group-hover/arch:opacity-100">
                      <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
                      Restore
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
