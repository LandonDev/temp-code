/**
 * The transcript's message list (TranscriptOutline.tsx): one line per
 * message the person wrote, its clock time, the one being read marked.
 * Pure rules here, so the tests drive placement and grouping directly
 * (jsdom lays nothing out).
 *
 * An entry is a turn's first block when it is the person's: a `user` block
 * (a steer whispered into a live turn is one, and so is an optimistic send)
 * or a `handoff` (its text is the person's brief). `groupTurns` starts a
 * turn at every such block, so there is at most one per turn. Reports,
 * restart nudges, reminders and notices are never user rows.
 */
import type { Attachment, Block } from "../lib/session";
import { threadMentionsToNames } from "../lib/threadMentions";

export type OutlineEntry = {
  /** The block's id, which the transcript jumps to. */
  id: string;
  /** The turn's index in the turns array: what the reader's position reads. */
  turnIndex: number;
  block: Block;
};

/** A turn's entry block, per turn array: a settled turn keeps its array
 *  (AgentTranscript's `stableTurns`), so a delta re-reads the live turn alone. */
const entryOfTurn = new WeakMap<Block[], Block | null>();

function entryBlock(turn: Block[]): Block | null {
  const hit = entryOfTurn.get(turn);
  if (hit !== undefined) return hit;
  const first = turn[0];
  const block = first && (first.role === "user" || first.role === "handoff") ? first : null;
  entryOfTurn.set(turn, block);
  return block;
}

export function outlineEntries(turns: readonly Block[][]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  turns.forEach((turn, turnIndex) => {
    const block = entryBlock(turn);
    if (block) entries.push({ id: block.id, turnIndex, block });
  });
  return entries;
}

const FENCE = /^(`{3,}|~{3,})/;
const MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;

/**
 * The line a message reads as: its first line with words, whitespace
 * collapsed, leading markdown markers and fences dropped, each
 * `@thread:<id>` named by the thread's title (else "a thread"). A message
 * with no words reads as its first attachment's name.
 */
export function entryLine(
  text: string,
  attachments: readonly Pick<Attachment, "name">[] | undefined,
  titleOf: (id: string) => string | undefined,
): string {
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (FENCE.test(line)) continue;
    line = line.replace(MARKER, "");
    line = threadMentionsToNames(line, (id) => titleOf(id) ?? "a thread");
    line = line.replace(/\s+/g, " ").trim();
    if (line) return line;
  }
  return attachments?.[0]?.name ?? "";
}

/** When the person wrote it: the user-text row's time, else the block's, else
 *  the instant an optimistic send was born. */
export function entryTime(block: Block): number | undefined {
  return block.startedAt ?? block.ts ?? block.born;
}

/** "2:32 PM" or "14:32", by the locale. */
export function entryClock(time: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(time);
}

export type DayGroup = {
  /** Today, Yesterday, Oct 30 (Oct 30, 2025 in another year); null for a
   *  thread that spans one day, which draws no label. */
  label: string | null;
  entries: OutlineEntry[];
};

function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(time: number, now: number, locale?: string): string {
  const day = new Date(time);
  const today = new Date(now);
  if (dayKey(time) === dayKey(now)) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(time) === dayKey(yesterday.getTime())) return "Yesterday";
  const sameYear = day.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(time);
}

/**
 * The entries by local day. Labels only when they span two or more days; an
 * entry with no time stays with the day before it.
 */
export function dayGroups(entries: readonly OutlineEntry[], now: number, locale?: string): DayGroup[] {
  const days = new Set<string>();
  for (const entry of entries) {
    const time = entryTime(entry.block);
    if (time !== undefined) days.add(dayKey(time));
  }
  if (days.size < 2) return entries.length ? [{ label: null, entries: [...entries] }] : [];
  const groups: DayGroup[] = [];
  let key: string | null = null;
  for (const entry of entries) {
    const time = entryTime(entry.block);
    const next = time === undefined ? key : dayKey(time);
    const last = groups[groups.length - 1];
    if (!last || (next !== null && next !== key)) {
      groups.push({ label: time === undefined ? null : dayLabel(time, now, locale), entries: [entry] });
      key = next;
    } else last.entries.push(entry);
  }
  return groups;
}

/*
 * Placement, against the transcript column (`COLUMN_MAX_CLASS`, 896px,
 * inside the scroller's 16px padding a side). The list is 208px wide, 16px
 * from the pane's left edge and 24px before the column: 248px of room.
 */
export const LIST_INSET_PX = 16;
export const LIST_WIDTH_PX = 208;
export const LIST_GAP_PX = 24;
export const LIST_SPACE = LIST_INSET_PX + LIST_WIDTH_PX + LIST_GAP_PX;
/** The column's class and its width; the thresholds follow both. */
export const COLUMN_MAX_CLASS = "max-w-4xl";
export const COLUMN_MAX_PX = 896;
/** The narrowest the column gets to make room for the list. */
export const COLUMN_MIN_PX = 600;
/** The scroller's own padding on the right. */
const PANE_PAD_PX = 16;

/** Under this the list hides. */
export const BESIDE_FROM_PX = LIST_SPACE + COLUMN_MIN_PX + PANE_PAD_PX;
/** From this the centred column leaves the list its gutter. */
export const GUTTER_FROM_PX = 2 * LIST_SPACE + COLUMN_MAX_PX;

/**
 * `gutter`: the column stays centred and the list sits in the room it
 * leaves; `beside`: the column moves right, flush after the list; `hidden`:
 * too narrow, or fewer than two messages. At `GUTTER_FROM_PX` the centred
 * column's left edge is already `LIST_SPACE`, so the switch moves nothing.
 */
export type OutlinePlacement = "hidden" | "beside" | "gutter";

export function outlinePlacement(paneWidth: number, count: number): OutlinePlacement {
  if (count < 2 || paneWidth < BESIDE_FROM_PX) return "hidden";
  return paneWidth < GUTTER_FROM_PX ? "beside" : "gutter";
}

/**
 * The entry being read: the last whose turn starts at or before the reader's
 * turn, else the first. Null with no entries.
 */
export function currentEntry(entries: readonly OutlineEntry[], readerTurn: number): string | null {
  if (entries.length === 0) return null;
  let lo = 0;
  let hi = entries.length - 1;
  if (entries[0].turnIndex > readerTurn) return entries[0].id;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].turnIndex <= readerTurn) lo = mid;
    else hi = mid - 1;
  }
  return entries[lo].id;
}

/** The reader's turn, per transcript: written by the scroll engine only when
 *  it changes, read by the list with `useSyncExternalStore`, so a scroll never
 *  renders the transcript. */
export type ReaderStore = {
  get: () => number;
  set: (turn: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createReaderStore(): ReaderStore {
  let turn = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => turn,
    set: (next) => {
      if (next === turn) return;
      turn = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
