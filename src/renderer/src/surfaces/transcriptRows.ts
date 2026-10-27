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
import { groupTurnItems, isProseBlock, type TurnItem } from "./transcriptActivity";

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

export type TranscriptRow =
  | {
      kind: "item";
      key: string;
      turn: TurnInfo;
      item: TurnItem;
      /** The run the agent is in: the running turn's last item, a group. */
      live: boolean;
      /** Prose straight after a group sits closer to it. */
      compactTop: boolean;
    }
  | { kind: "end"; key: string; turn: TurnInfo }
  /** The remote profile's "Load earlier messages", above everything. */
  | { kind: "more"; key: "more" };

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

export function flattenTurns(
  turns: Block[][],
  busy: boolean,
  options: { loadEarlier?: boolean } = {},
): TranscriptRows {
  const rows: TranscriptRow[] = [];
  if (options.loadEarlier) rows.push({ kind: "more", key: "more" });
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
      settled: !(busy && isLast),
      blocks,
      userBlock,
      durationMs,
      startedAt: userBlock?.startedAt,
    };
    const items = itemsOf(blocks);
    items.forEach((item, itemIndex) => {
      if (item.type === "activity") {
        rows.push({
          kind: "item",
          key: item.blocks[0].id,
          turn,
          item,
          live: !turn.settled && itemIndex === items.length - 1,
          compactTop: false,
        });
        return;
      }
      rows.push({
        kind: "item",
        key: item.block.id,
        turn,
        item,
        live: false,
        compactTop: items[itemIndex - 1]?.type === "activity" && isProseBlock(item.block),
      });
    });
    rows.push({ kind: "end", key: `${turn.id}:end`, turn });
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

/** Pixels per wrapped line of prose, and about how many characters fit one. */
const PROSE_LINE = 24;
const PROSE_CHARS = 80;
/** A group's closed line and an action row share one height. */
const ACTIVITY_ROW = 32;

/**
 * A row's height before it is measured: close enough that the scrollbar
 * and the window's reach are right to within a screen, never exact.
 */
export function estimateRowHeight(row: TranscriptRow): number {
  if (row.kind === "more") return 52;
  if (row.kind === "end") return row.turn.durationMs != null || row.turn.isLast ? 36 : 0;
  const { item } = row;
  if (item.type === "activity") {
    // Closed by default: one line, or the lone call's own row.
    return ACTIVITY_ROW;
  }
  const block = item.block;
  switch (block.role) {
    case "user": {
      // 20px above, 8px below, the bubble's padding and 24px a line (4 at most).
      const lines = Math.min(4, Math.max(1, block.text.split("\n").length));
      return 52 + 24 * lines + (block.attachments?.length ? 40 : 0) + (block.preamble ? 28 : 0);
    }
    case "tool":
    case "approval":
      return ACTIVITY_ROW + (block.question ? 160 : 0);
    case "assistant":
    case "plan": {
      const text = block.text;
      const fences = (text.match(/```/g)?.length ?? 0) / 2;
      const lines = text.split("\n").reduce(
        (n, line) => n + Math.max(1, Math.ceil(line.length / PROSE_CHARS)),
        0,
      );
      return 16 + PROSE_LINE * lines + 40 * fences;
    }
    case "system":
      return block.compaction || block.agent ? 56 : 40;
    case "handoff":
      return 48;
    default:
      return 40;
  }
}
