import type { MenuRow } from "../chrome/menuRows";
import type { TabGroupMenuExtraItem } from "../chrome/TabGroupMenu";
import { Archive, Check, Pause, Play, Square } from "../chrome/icons";
import type { SessionMeta } from "./tcserver/types";
import { BATCH_ACTIONS, BATCH_LABEL, batchTargets, type BatchAction, type BatchSelection } from "./threadBatch";

/**
 * The fleet switches as menu rows (`MenuRow`s), for the project and group
 * menus. A row whose count is zero is
 * disabled rather than hidden, so the menu keeps its shape from one open
 * to the next and the eye lands where it did last time.
 */

export type BatchCounts = Record<BatchAction, number>;

const MENU_ID_PREFIX = "batch-";

export function batchMenuId(action: BatchAction): string {
  return MENU_ID_PREFIX + action;
}

/** The action a menu id names, or null for any other row. */
export function batchActionOfMenuId(id: string): BatchAction | null {
  if (!id.startsWith(MENU_ID_PREFIX)) return null;
  const action = id.slice(MENU_ID_PREFIX.length) as BatchAction;
  return BATCH_ACTIONS.includes(action) ? action : null;
}

/** How many roots each action would touch, for the rows' disabled state. */
export function batchCounts(metas: readonly SessionMeta[], sel: BatchSelection): BatchCounts {
  const out = {} as BatchCounts;
  for (const action of BATCH_ACTIONS) out[action] = batchTargets(action, metas, sel).length;
  return out;
}

const ICON: Record<BatchAction, TabGroupMenuExtraItem["icon"]> = {
  pause: Pause,
  resume: Play,
  stop: Square,
  archiveDone: Archive,
};

/** The project menu's rows: Pause all, Resume all, Stop all, Archive done,
 *  as one group after Mark all read. */
export function batchMenuExtraItems(counts: BatchCounts | null): TabGroupMenuExtraItem[] {
  return BATCH_ACTIONS.map((action, index) => ({
    id: batchMenuId(action),
    label: BATCH_LABEL[action],
    icon: ICON[action],
    disabled: counts ? counts[action] === 0 : true,
    danger: action === "stop",
    sepBefore: index === 0,
  }));
}

/** The fleet switches as one group of rows: Mark all read first when a
 *  count is given, then Pause all, Resume all, Stop all and Archive done. */
export function batchMenuRows(counts: BatchCounts | null, readCount?: number): MenuRow[] {
  const rows: MenuRow[] = [];
  if (readCount !== undefined) rows.push({ kind: "item", id: "read", label: "Mark all read", icon: Check, disabled: readCount === 0 });
  for (const action of BATCH_ACTIONS) {
    rows.push({
      kind: "item",
      id: batchMenuId(action),
      label: BATCH_LABEL[action],
      icon: ICON[action],
      disabled: counts ? counts[action] === 0 : true,
      danger: action === "stop",
    });
  }
  return rows;
}
