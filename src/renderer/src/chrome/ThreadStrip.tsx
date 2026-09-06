import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { SPRING_LAYOUT } from "../lib/ease";
import type { ThreadType } from "../lib/tcserver/types";
import { splitStrip } from "../lib/threadStrip";
import { THREAD_GLYPHS, THREAD_TINTS, timeAgo } from "../surfaces/threads/bits";
import { HarnessIcon } from "./HarnessIcon";
import { Archive, ArchiveRestore, Search } from "./icons";
import { Popover } from "./Popover";
import { TabIndicator } from "./TabIndicator";
import { tabCopy, type Tab } from "./TitleBar";

/** An archived thread of the selected project, recoverable from the shelf. */
export type ArchivedThread = {
  id: string;
  title: string;
  type: ThreadType | null;
  updatedAt: number;
};

type ChipEvents = {
  activeId: string;
  now: number;
  renamingId: string | null;
  onSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onContextMenu: (tab: Tab, event: ReactMouseEvent<HTMLDivElement>) => void;
  activeRef: (el: HTMLDivElement | null) => void;
};

/** Mouse wheels only emit deltaY; turn it sideways. Trackpad swipes keep
 *  native scrolling. */
function wheelToX(event: ReactWheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.currentTarget.scrollLeft += event.deltaY;
  }
}

/**
 * Threads of the selected project as soft chips, temp-code's ThreadStrip:
 * live chips on the top row, the dormant shelf a line below, each row
 * freshest first. The active wash glides between chips on a shared
 * layoutId, chips slide closed on archive and glide on reorder. Nothing
 * here closes a thread; right-click renames or archives, and the shelf at
 * the strip's end brings archived threads back.
 */
export function ThreadStrip({
  tabs,
  archived,
  onRestore,
  stripRef,
  ...events
}: ChipEvents & {
  tabs: Tab[];
  archived: ArchivedThread[];
  onRestore: (sessionId: string) => void;
  /** The live row's scroller, for the title bar's overflow chevrons. */
  stripRef: (el: HTMLDivElement | null) => void;
}) {
  const reduce = useReducedMotion();
  const { live, dorm } = splitStrip(tabs);
  const enter = reduce ? false : { opacity: 0, scale: 0.9 };
  const exit = reduce ? undefined : { opacity: 0, scale: 0.9 };

  return (
    <MotionConfig reducedMotion="user" transition={SPRING_LAYOUT}>
      <motion.div layoutRoot className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 min-w-0 items-center">
          <motion.div
            layoutScroll
            ref={stripRef}
            onWheel={wheelToX}
            data-strip="live"
            className="scrollbar-none flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {live.map((tab) => (
                <motion.div
                  key={tab.id}
                  layout
                  initial={enter}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={exit}
                  transition={SPRING_LAYOUT}
                  className="shrink-0"
                  data-tauri-drag-region="false"
                  ref={
                    tab.id === events.activeId ? events.activeRef : undefined
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    events.onContextMenu(tab, event);
                  }}
                >
                  <LiveChip tab={tab} {...events} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
          <div className="min-w-1.5 flex-1" />
          <ArchivedShelf archived={archived} onRestore={onRestore} />
        </div>
        {dorm.length > 0 ? (
          <motion.div
            layoutScroll
            onWheel={wheelToX}
            data-strip="shelf"
            className="scrollbar-none flex h-7 min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none px-1.5 pb-1"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {dorm.map((tab) => (
                <motion.div
                  key={tab.id}
                  layout
                  initial={enter}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={exit}
                  transition={SPRING_LAYOUT}
                  className="shrink-0"
                  data-tauri-drag-region="false"
                  ref={
                    tab.id === events.activeId ? events.activeRef : undefined
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    events.onContextMenu(tab, event);
                  }}
                >
                  <ShelfChip tab={tab} {...events} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </motion.div>
    </MotionConfig>
  );
}

/** The active chip's wash; one element that glides between chips. */
function Wash() {
  return (
    <motion.div
      layoutId="thread-strip-wash"
      transition={SPRING_LAYOUT}
      className="absolute inset-0 rounded-md bg-content/10"
    />
  );
}

function ChipGlyph({
  tab,
  dimmed,
  size,
}: {
  tab: Tab;
  dimmed: boolean;
  size: string;
}) {
  const type =
    tab.thread?.type && tab.thread.type !== "chat"
      ? (tab.thread.type as ThreadType)
      : null;
  if (type) {
    const Glyph = THREAD_GLYPHS[type];
    return (
      <Glyph
        className={`${size} shrink-0 ${THREAD_TINTS[type]} ${dimmed ? "opacity-60 grayscale" : "opacity-80"}`}
        strokeWidth={1.75}
      />
    );
  }
  if (tab.harnesses[0]) {
    return (
      <span
        className={`flex shrink-0 items-center ${dimmed ? "opacity-60 grayscale" : ""}`}
      >
        <HarnessIcon harness={tab.harnesses[0]} className={size} />
      </span>
    );
  }
  return null;
}

function RenameInput({
  tab,
  className,
  onRename,
}: {
  tab: Tab;
  className: string;
  onRename: (id: string, title: string) => void;
}) {
  return (
    <input
      autoFocus
      defaultValue={tab.title}
      data-tauri-drag-region="false"
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = tab.title;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => onRename(tab.id, event.target.value.trim())}
      className={`rounded-md bg-content/10 text-content outline-none ${className}`}
    />
  );
}

function LiveChip({ tab, ...events }: { tab: Tab } & ChipEvents) {
  const active = tab.id === events.activeId;
  const { headline, tooltip } = tabCopy(tab, { deckLayout: true });
  if (events.renamingId === tab.id) {
    return (
      <RenameInput
        tab={tab}
        onRename={events.onRename}
        className="h-[26px] w-44 px-2.5 text-[13px]"
      />
    );
  }
  const unread = !active && !!tab.thread?.unread;
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      aria-selected={active}
      data-tauri-drag-region="false"
      onClick={() => events.onSelect(tab.id)}
      onDoubleClick={() => events.onStartRename(tab.id)}
      className={`relative flex h-[26px] max-w-56 min-w-0 cursor-default items-center gap-1.5 rounded-md px-2.5 text-[13px] leading-none ${
        active
          ? "text-content"
          : "text-content/55 hover:bg-content/5 hover:text-content"
      }`}
    >
      {active ? <Wash /> : null}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <ChipGlyph tab={tab} dimmed={!active} size="size-[13px]" />
        <span
          className={`min-w-0 truncate ${unread ? "font-medium text-content" : ""}`}
        >
          {headline}
        </span>
        {tab.dirty ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-content/70"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        ) : null}
        {tab.thread ? (
          <TabIndicator thread={tab.thread} now={events.now} />
        ) : null}
      </span>
    </button>
  );
}

function ShelfChip({ tab, ...events }: { tab: Tab } & ChipEvents) {
  const active = tab.id === events.activeId;
  const { headline, tooltip } = tabCopy(tab, { deckLayout: true });
  if (events.renamingId === tab.id) {
    return (
      <RenameInput
        tab={tab}
        onRename={events.onRename}
        className="h-5 w-36 px-1.5 text-[11.5px]"
      />
    );
  }
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      aria-selected={active}
      data-tauri-drag-region="false"
      onClick={() => events.onSelect(tab.id)}
      onDoubleClick={() => events.onStartRename(tab.id)}
      className={`relative flex h-5 max-w-36 min-w-0 cursor-default items-center gap-1 rounded-md px-1.5 text-[11.5px] leading-none ${
        active
          ? "text-content"
          : "text-content/70 opacity-70 hover:bg-content/5 hover:text-content hover:opacity-100"
      }`}
    >
      {active ? <Wash /> : null}
      <span className="relative flex min-w-0 items-center gap-1">
        <ChipGlyph tab={tab} dimmed={!active} size="size-3" />
        <span className="min-w-0 truncate">{headline}</span>
        {tab.thread ? (
          <TabIndicator thread={tab.thread} now={events.now} />
        ) : null}
      </span>
    </button>
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
  const shown = q
    ? archived.filter((t) => t.title.toLowerCase().includes(q))
    : archived;
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
              <p className="px-2 py-3 text-center text-[11px] text-content/45">
                No matches.
              </p>
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
                      <span className="block text-[11px] text-content/45">
                        {timeAgo(thread.updatedAt)}
                      </span>
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
