import {
  isLiveThread,
  isUnread,
  splitThreads,
  stripRootThreads,
  type ReadyMap,
  type SeenMap,
  type StripScope,
  type StripThread,
} from "./threadStripModel";
import type { SessionStatus } from "./tcserver/types";

/**
 * The header model: which chips the strip shows for the selected project
 * (or the scope's loose chats) and how each maps onto the workspace's tabs.
 * A chip is a root thread; a WorkspaceTab is a pane layout that may hold
 * that thread or its subagents (plus files, terminals, other threads).
 * Selecting a chip activates its tab when one is open, otherwise the caller
 * opens the thread. A thread with no tab still shows: the strip is the
 * scope's threads, not the open tabs. The live chips are the top row, the
 * settled ones the shelf under it; the thread on screen always has a chip.
 */

export type HeaderTab = {
  id: string;
  /** Pane ids of the tab (threads, files, terminals), focused first. */
  sessionIds: readonly string[];
};

export type HeaderChip<T extends StripThread = StripThread> = {
  id: string;
  thread: T;
  /** The open tab holding this thread or one of its subagents, if any. */
  tabId: string | null;
  live: boolean;
  /** The root's own status; the tree's overrides are `threadStatus`'s. */
  status: SessionStatus;
  unread: boolean;
  updatedAt: number;
};

export type HeaderModel<T extends StripThread = StripThread> = {
  /** The top row: the scope's live chips, then the outside chip. */
  live: HeaderChip<T>[];
  /** The shelf: the scope's settled chips, freshest first. */
  dormant: HeaderChip<T>[];
  /** The root of the thread on screen, when it is a chip on this strip. */
  activeId: string | null;
  /** The thread on screen when the scope does not hold it (another scope's
   *  thread, a batch child): its chip ends the live row and is never saved
   *  into the order. */
  outsideId?: string | null;
};

/** The root of `id`'s thread, by the parentId chain over the threads known. */
export function rootOf(threads: readonly StripThread[], id: string): string {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return rootIn(byId, id);
}

function rootIn(byId: ReadonlyMap<string, StripThread>, id: string): string {
  let at = byId.get(id);
  for (let hops = 0; at?.parentId && byId.has(at.parentId) && hops < 64; hops++) at = byId.get(at.parentId);
  return at?.id ?? id;
}

/** The thread a tab shows: the root of its focused thread pane, else (a file
 *  or terminal pane focused) the root of its first thread; null when it holds
 *  no thread. `paneIds` are focused first. */
export function tabRoot(threads: readonly StripThread[], paneIds: readonly string[]): string | null {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const first = paneIds.find((id) => byId.has(id));
  return first ? rootIn(byId, first) : null;
}

export function buildHeaderModel<T extends StripThread>(input: {
  threads: readonly T[];
  tabs: readonly HeaderTab[];
  scope: StripScope;
  activeTabId: string | null;
  lastSeen: SeenMap;
  /** Threads with no lastSeen entry count as seen up to this time. */
  seenFloor?: number;
  planReady: ReadyMap;
}): HeaderModel<T> {
  const roots = stripRootThreads(input.threads, input.scope);
  const byId = new Map<string, T>(input.threads.map((t) => [t.id, t]));
  const shown = input.tabs.find((tab) => tab.id === input.activeTabId)?.sessionIds ?? [];
  const onScreenId = tabRoot(input.threads, shown);
  const onScreen = onScreenId ? byId.get(onScreenId) : undefined;
  const tabOf = tabIndex(input.tabs, (id) => (byId.has(id) ? rootIn(byId, id) : id));
  const floor = input.seenFloor ?? 0;
  const { live, dormant } = splitThreads(roots, input.lastSeen, input.planReady, floor);
  const chip = (thread: T, isLive: boolean): HeaderChip<T> => {
    // A local draft has no server meta to stamp seen; it is new, not unread.
    const unread = !thread.draft && isUnread(thread, input.lastSeen, floor);
    return {
      id: thread.id,
      thread,
      tabId: tabOf.get(thread.id) ?? null,
      live: isLive,
      status: thread.status,
      unread,
      updatedAt: thread.updatedAt,
    };
  };
  const outside =
    onScreen && !onScreen.parentId && !onScreen.archived && !roots.includes(onScreen)
      ? chip(onScreen, isLiveThread(onScreen, input.lastSeen, input.planReady, floor))
      : null;
  const model = {
    live: [...live.map((t) => chip(t, true)), ...(outside ? [outside] : [])],
    dormant: dormant.map((t) => chip(t, false)),
  };
  const drawn = onScreenId && [...model.live, ...model.dormant].some((c) => c.id === onScreenId);
  return { ...model, activeId: drawn ? onScreenId : null, outsideId: outside?.id ?? null };
}

/** The ids the saved order may keep: the live row less the outside chip. */
export function saveIds<T extends StripThread>(model: HeaderModel<T>): string[] {
  return model.live.flatMap((chip) => (chip.id === model.outsideId ? [] : [chip.id]));
}

/**
 * The strip's stable order, the way a browser orders tabs: the ids already in
 * `order` keep their places, the ones gone drop out, and new ones join at the
 * end, oldest first when several arrive at once (so a cold start reads left
 * to right by age). A status change never moves a chip.
 */
export function orderChips(
  order: readonly string[],
  chips: readonly { id: string; updatedAt: number }[],
): string[] {
  const present = new Set(chips.map((c) => c.id));
  const kept = order.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = chips
    .filter((c) => !known.has(c.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((c) => c.id);
  return added.length === 0 && kept.length === order.length ? [...order] : [...kept, ...added];
}

/**
 * While `holding` (the pointer is over the strip) a chip that left `next`
 * stays where it was, so nothing shifts under the cursor after a click; new
 * ones still join at the end. Once `holding` is false the departures go.
 */
export function holdDepartures(
  shown: readonly string[],
  next: readonly string[],
  holding: boolean,
): string[] {
  if (!holding) return [...next];
  const shownSet = new Set(shown);
  return [...shown, ...next.filter((id) => !shownSet.has(id))];
}

/**
 * The model with departures held: while `holding`, a chip in `shown` (the row
 * last drawn) whose thread settled in this scope keeps its place in `live` and
 * leaves `dormant`; another scope's chip never holds, and the outside chip
 * stays last. Once `holding` is false the model is as built.
 */
export function holdModel<T extends StripThread>(
  model: HeaderModel<T>,
  shown: readonly string[],
  holding: boolean,
): HeaderModel<T> {
  if (!holding) return model;
  const outside = model.live.find((chip) => chip.id === model.outsideId);
  const inScope = outside ? model.live.filter((chip) => chip !== outside) : model.live;
  const byId = new Map(model.dormant.map((chip) => [chip.id, chip]));
  for (const chip of inScope) byId.set(chip.id, chip);
  const ids = holdDepartures(
    shown.filter((id) => byId.has(id)),
    inScope.map((chip) => chip.id),
    true,
  );
  if (ids.length === inScope.length) return model;
  const held = new Set(ids);
  return {
    live: [...ids.map((id) => byId.get(id)!), ...(outside ? [outside] : [])],
    dormant: model.dormant.filter((chip) => !held.has(chip.id)),
    activeId: model.activeId,
    outsideId: model.outsideId,
  };
}

/** The model as the strip draws it: the live row in its stable order
 *  (`order` is the saved one; see orderChips) with the outside chip last,
 *  the shelf freshest first. */
export function orderModel<T extends StripThread>(
  model: HeaderModel<T>,
  order: readonly string[],
): HeaderModel<T> {
  const outside = model.live.find((chip) => chip.id === model.outsideId);
  const inScope = outside ? model.live.filter((chip) => chip !== outside) : model.live;
  const byId = new Map(inScope.map((chip) => [chip.id, chip]));
  return {
    live: [...orderChips(order, inScope).map((id) => byId.get(id)!), ...(outside ? [outside] : [])],
    dormant: model.dormant,
    activeId: model.activeId,
    outsideId: model.outsideId,
  };
}

/** The key a project's strip order is saved under: a linked project's
 *  copies on every host share their link id, so they share one order. */
export function stripScopeKey(
  project: { id: string; linkId?: string | null } | undefined,
  workspaceId: string | null,
): string {
  if (project) return project.linkId ? `link:${project.linkId}` : project.id;
  return `loose:${workspaceId ?? ""}`;
}

/** The thread ⌘1–9 selects: the nth chip as drawn (`slot` < 0 the last),
 *  opened as a click on it opens it, so a chip sharing a split focuses its
 *  own pane and a chip with no tab opens its thread. */
export function slotTarget<T extends StripThread>(model: HeaderModel<T>, slot: number): string | null {
  const chip = slot < 0 ? model.live[model.live.length - 1] : model.live[slot];
  return chip?.id ?? null;
}

/** Strip order for next/previous: the live row, then the shelf. */
export function headerOrder<T extends StripThread>(model: HeaderModel<T>): HeaderChip<T>[] {
  return [...model.live, ...model.dormant];
}

/** The chip that takes selection when the active chip `id` is archived:
 *  its neighbour on its own row (the next, else the one before), else the
 *  first of the other row; null when `id` is not active or was the last. */
export function archiveNeighbour<T extends StripThread>(
  model: HeaderModel<T>,
  id: string,
): HeaderChip<T> | null {
  if (model.activeId !== id) return null;
  const onShelf = model.dormant.some((c) => c.id === id);
  const row = onShelf ? model.dormant : model.live;
  const at = row.findIndex((c) => c.id === id);
  const rest = row.filter((c) => c.id !== id);
  if (rest.length > 0) return rest[Math.min(Math.max(at, 0), rest.length - 1)];
  return (onShelf ? model.live : model.dormant)[0] ?? null;
}

/** Thread id → the first tab that holds it or one of its subagents (`keyOf`
 *  maps a pane id to its root). A thread on several tabs belongs to the
 *  first in tab order. */
function tabIndex(tabs: readonly HeaderTab[], keyOf: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tab of tabs)
    for (const id of tab.sessionIds) {
      const key = keyOf(id);
      if (!out.has(key)) out.set(key, tab.id);
    }
  return out;
}
