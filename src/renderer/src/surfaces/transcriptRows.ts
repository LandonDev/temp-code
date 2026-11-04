/**
 * The transcript as a flat list of rows for the viewport window
 * (lib/transcriptWindow.ts): one row per turn item (a block, or a group of
 * tool calls) and one closing row per turn (its duration line, the live
 * timer or the thinking tail). Each row carries what its view needs from
 * the turn, so a row renders on its own, wherever in the list it sits.
 *
 * Rows are keyed by the id of their first block (the turn id plus `:end`
 * for the closing row), so a row keeps its identity as the window moves,
 * as a turn grows into it, and across a rebuild with older turns added
 * above. Items are cached per turn array: `stableTurns` keeps a settled
 * turn's array, so only the live turn regroups on a delta.
 */
import type { Block } from "../lib/session";
import { isErrorBlock } from "../lib/turnOutcome";
import { awaitsUser, groupTurnItems, isHtmlRenderBlock, isStepBlock, isThinkingBlock, isTodoBlock, stepRows, toldByWorkingLine, type TurnItem } from "./transcriptActivity";

export type TurnInfo = {
  id: string;
  index: number;
  isLast: boolean;
  /** Whether the turn is over, or the live turn is not running. */
  settled: boolean;
  blocks: Block[];
  userBlock: Block | undefined;
  durationMs: number | undefined;
  startedAt: number | undefined;
};

/**
 * The space above a row, in px: it belongs to the boundary between the row
 * and the one before it, never to the row (docs/DESIGN.md "The
 * transcript"). A row that draws nothing takes none (RowView applies it
 * only to a row with content).
 */
export const ROW_GAP = {
  /** Nothing above: the thread's first row. */
  first: 16,
  /** The previous turn to a turn's first row. */
  turn: 32,
  /** The person's bubble to its first reply row. */
  reply: 16,
  /** Two blocks, or a block and a line. */
  block: 12,
  /** Two lines. */
  line: 4,
  /** The last item to the turn's closing line. */
  end: 8,
  /** "Load earlier messages" to the first row. */
  more: 8,
} as const;

export type RowGap = (typeof ROW_GAP)[keyof typeof ROW_GAP];

export type TranscriptRow =
  | {
      kind: "item";
      key: string;
      turn: TurnInfo;
      item: TurnItem;
      /** The run the agent is in: the running turn's last item, a group. */
      live: boolean;
      /** The open turn (running or paused) works in this group: it is the
       *  turn's last item, or only a step waiting on the person follows it.
       *  The group opens on its own while this holds (ActionGroup). */
      working: boolean;
      gap: RowGap;
    }
  | { kind: "end"; key: string; turn: TurnInfo; gap: RowGap }
  /** The remote profile's "Load earlier messages", above everything. */
  | { kind: "more"; key: "more"; gap: RowGap };

export type TranscriptRows = {
  rows: TranscriptRow[];
  /** The row that shows each block, by block id; built on first use, so a
   *  streamed delta that nothing jumps on never walks the thread. */
  rowOfBlock: () => Map<string, number>;
};

const itemCache = new WeakMap<Block[], TurnItem[]>();

function itemsOf(turn: Block[]): TurnItem[] {
  const hit = itemCache.get(turn);
  if (hit) return hit;
  const items = groupTurnItems(turn);
  itemCache.set(turn, items);
  return items;
}

export function turnUserBlock(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") return blocks[i];
  }
  return undefined;
}

/** An approval or a question still waiting on the person: the work has not
 *  moved past the group above it. */
function waitsOnPerson(item: TurnItem): boolean {
  return item.type === "block" && awaitsUser(item.block);
}

/** What a turn item draws: one 28px line (a group, an action, a thought, a
 *  notice, an approval), the person's bubble, or a block (prose, a plan, a
 *  card: a question, a failure, a held review, a page, a task list). */
function shapeOf(item: TurnItem): "line" | "bubble" | "block" {
  if (item.type === "activity") return "line";
  const block = item.block;
  switch (block.role) {
    case "user":
      return "bubble";
    case "assistant":
    case "plan":
      return "block";
    case "approval":
      return "line";
    case "tool":
      return block.question || isTodoBlock(block) || isHtmlRenderBlock(block) ? "block" : "line";
    case "system":
      return isErrorBlock(block) || (block.review?.outcome === "held" && !block.review.resolved) ? "block" : "line";
    default:
      return "line";
  }
}

/** The gap above a turn item, from the item before it in its turn (null for
 *  the turn's first) and the row before it in the list. */
function gapAbove(item: TurnItem, before: TurnItem | null, previousRow: TranscriptRow | undefined): RowGap {
  if (!previousRow) return ROW_GAP.first;
  if (!before) return previousRow.kind === "more" ? ROW_GAP.more : ROW_GAP.turn;
  const above = shapeOf(before);
  if (above === "bubble") return ROW_GAP.reply;
  return above === "line" && shapeOf(item) === "line" ? ROW_GAP.line : ROW_GAP.block;
}

/**
 * `busy`: the last turn runs, so its last activity row is live. `paused`
 * (options): it is paused mid-turn, so it stays open, with no closing line
 * until it settles, but nothing in it reads as running.
 */
export function flattenTurns(
  turns: Block[][],
  busy: boolean,
  options: { loadEarlier?: boolean; paused?: boolean } = {},
): TranscriptRows {
  const open = busy || !!options.paused;
  const rows: TranscriptRow[] = [];
  if (options.loadEarlier) rows.push({ kind: "more", key: "more", gap: ROW_GAP.first });
  turns.forEach((blocks, index) => {
    const isLast = index === turns.length - 1;
    const userBlock = turnUserBlock(blocks);
    // A steered turn closes its earlier sections by doneTs alone.
    const durationMs =
      userBlock?.durationMs ??
      (userBlock?.doneTs != null && userBlock.startedAt != null
        ? Math.max(0, userBlock.doneTs - userBlock.startedAt)
        : undefined);
    const turn: TurnInfo = {
      id: blocks[0].id,
      index,
      isLast,
      settled: !(open && isLast),
      blocks,
      userBlock,
      durationMs,
      startedAt: userBlock?.startedAt,
    };
    const items = itemsOf(blocks);
    items.forEach((item, itemIndex) => {
      const gap = gapAbove(item, itemIndex === 0 ? null : items[itemIndex - 1], rows[rows.length - 1]);
      if (item.type === "activity") {
        rows.push({
          kind: "item",
          key: item.blocks[0].id,
          turn,
          item,
          live: busy && isLast && itemIndex === items.length - 1,
          working: open && isLast && items.slice(itemIndex + 1).every(waitsOnPerson),
          gap,
        });
        return;
      }
      rows.push({ kind: "item", key: item.block.id, turn, item, live: false, working: false, gap });
    });
    rows.push({ kind: "end", key: `${turn.id}:end`, turn, gap: ROW_GAP.end });
  });
  let map: Map<string, number> | null = null;
  const rowOfBlock = (): Map<string, number> => {
    if (map) return map;
    map = new Map();
    rows.forEach((row, index) => {
      if (row.kind !== "item") return;
      if (row.item.type === "activity") {
        for (const block of row.item.blocks) map!.set(block.id, index);
      } else map!.set(row.item.block.id, index);
    });
    return map;
  };
  return { rows, rowOfBlock };
}

function sameItem(a: TurnItem, b: TurnItem): boolean {
  if (a === b) return true;
  if (a.type === "block") return b.type === "block" && a.block === b.block;
  if (b.type === "block") return false;
  return a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block === b.blocks[i]);
}

function sameTurn(a: TurnInfo, b: TurnInfo): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.index === b.index &&
      a.isLast === b.isLast &&
      a.settled === b.settled &&
      a.blocks === b.blocks &&
      a.userBlock === b.userBlock &&
      a.durationMs === b.durationMs &&
      a.startedAt === b.startedAt)
  );
}

/**
 * Whether a row draws the same as before. Every flatten builds new rows, and
 * a delta into the live turn regroups it, so its other rows come back as new
 * objects holding the same blocks; RowView compares with this instead of
 * identity, so the delta re-renders the row it changed and the closing row.
 * An item row reads its turn's id, index, whether it is the last and whether
 * it is over (a group draws its running calls once it is); the closing row
 * reads the whole turn.
 */
export function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key || a.gap !== b.gap) return false;
  if (a.kind === "more" || b.kind === "more") return true;
  if (a.kind === "end" || b.kind === "end") return sameTurn(a.turn, b.turn);
  return (
    a.live === b.live &&
    a.working === b.working &&
    a.turn.id === b.turn.id &&
    a.turn.index === b.turn.index &&
    a.turn.isLast === b.turn.isLast &&
    a.turn.settled === b.turn.settled &&
    sameItem(a.item, b.item)
  );
}

/** Pixels per wrapped line of prose (14px on 22px), and about how many
 *  characters fit one in the 768px column. */
const PROSE_LINE = 22;
const PROSE_CHARS = 100;
/** Every line row: an action, a group's line, a thought, a notice, the closing line;
 *  a row hung in an open group's list is 26px (transcript/stepLine.ts). */
const LINE = 28;
const HUNG_LINE = 26;
/** How many rows a group shows while it works on its own (a thought counts). */
export const GROUP_WINDOW = 5;

/**
 * A row's height before it is measured, its gap included: close enough
 * that the scrollbar and the window's reach are right to within a screen,
 * never exact. A row that draws nothing (a closing row with no line, a run
 * of thoughts alone, one call the working line tells) is 0, gap and all.
 */
export function estimateRowHeight(row: TranscriptRow): number {
  if (row.kind === "more") return row.gap + LINE;
  if (row.kind === "end") return row.turn.durationMs != null || row.turn.isLast ? row.gap + LINE : 0;
  const height = itemHeight(row.item, row.working, row.turn.settled);
  return height ? row.gap + height : 0;
}

function itemHeight(item: TurnItem, working: boolean, settled: boolean): number {
  if (item.type === "activity") {
    // The rows ActionGroup draws: no thought (a hand opens those), and no
    // call the working line tells while the turn is open; a step counts its
    // own rows (a wait's outcomes, a batch spawn's children). A lone run is
    // those rows; a group is its line, open on its newest five rows while
    // the turn works in it, else closed.
    const rows = (b: Block) => (isStepBlock(b) ? stepRows(b) : 1);
    const shown = item.blocks.filter((b) => !isThinkingBlock(b) && (settled || !toldByWorkingLine(b))).reduce((n, b) => n + rows(b), 0);
    if (item.blocks.reduce((n, b) => n + (isStepBlock(b) ? stepRows(b) : 0), 0) <= 1) return LINE * shown;
    return working ? LINE + HUNG_LINE * Math.min(GROUP_WINDOW, shown) : LINE;
  }
  const block = item.block;
  switch (block.role) {
    case "user": {
      // The bubble's 8px padding top and bottom, 22px a line (12 at most),
      // an attachment strip, and the preamble's 24px line 4px above.
      const lines = Math.min(12, Math.max(1, block.text.split("\n").length));
      return 16 + PROSE_LINE * lines + (block.attachments?.length ? 40 : 0) + (block.preamble ? 28 : 0);
    }
    case "tool":
    case "approval":
      return LINE + (block.question ? 160 : 0);
    case "assistant":
    case "plan": {
      const text = block.text;
      const fences = (text.match(/```/g)?.length ?? 0) / 2;
      const lines = text.split("\n").reduce(
        (n, line) => n + Math.max(1, Math.ceil(line.length / PROSE_CHARS)),
        0,
      );
      return PROSE_LINE * lines + 40 * fences;
    }
    case "system":
      return isErrorBlock(block) ? 88 : LINE;
    default:
      return LINE;
  }
}
