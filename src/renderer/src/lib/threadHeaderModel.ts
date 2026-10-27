import {
  isUnread,
  projectRootThreads,
  splitThreads,
  type ReadyMap,
  type SeenMap,
  type ProjectScope,
  type StripThread,
} from "./threadStripModel";
import type { SessionStatus } from "./tcserver/types";

/**
 * The header model: which chips the strip shows for the selected project
 * and how each maps onto the workspace's tabs. A chip is a root thread; a
 * WorkspaceTab is a pane layout that may hold that thread (plus files,
 * terminals, other threads). Selecting a chip activates its tab when one
 * is open, otherwise the caller opens the thread. A thread with no tab
 * still shows — the strip is the project's threads, not the open tabs.
 */

export type HeaderTab = {
  id: string;
  /** Session ids on the tab's panes, focused first. */
  sessionIds: readonly string[];
};

export type HeaderChip<T extends StripThread = StripThread> = {
  id: string;
  thread: T;
  /** The open tab holding this thread, if any. */
  tabId: string | null;
  live: boolean;
  /** The root's own status; the tree's overrides are `threadStatus`'s. */
  status: SessionStatus;
  unread: boolean;
  updatedAt: number;
};

export type HeaderModel<T extends StripThread = StripThread> = {
  live: HeaderChip<T>[];
  dormant: HeaderChip<T>[];
  /** The active tab's thread, when it is a chip on this strip. */
  activeId: string | null;
};

export function buildHeaderModel<T extends StripThread>(input: {
  threads: readonly T[];
  tabs: readonly HeaderTab[];
  selectedProjectId: ProjectScope;
  activeTabId: string | null;
  lastSeen: SeenMap;
  /** Threads with no lastSeen entry count as seen up to this time. */
  seenFloor?: number;
  planReady: ReadyMap;
}): HeaderModel<T> {
  const roots = projectRootThreads(input.threads, input.selectedProjectId);
  const tabOf = tabIndex(input.tabs);
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
  const model = {
    live: live.map((t) => chip(t, true)),
    dormant: dormant.map((t) => chip(t, false)),
  };
  const active = [...model.live, ...model.dormant].find(
    (c) => c.tabId != null && c.tabId === input.activeTabId,
  );
  return { ...model, activeId: active?.id ?? null };
}

/** The chips the strip draws: the live ones, plus the thread on screen when
 *  it is dormant (the thread on screen always has its chip). The dormant
 *  rest is "Recent threads" in the thread menu. */
export function stripChips<T extends StripThread>(model: HeaderModel<T>): HeaderChip<T>[] {
  const active = model.dormant.find((c) => c.id === model.activeId);
  return active ? [...model.live, active] : model.live;
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

/** The model as the strip draws it: `live` is the drawn chips in their
 *  stable order (`order` is the saved one; see orderChips), `dormant` the
 *  rest for "Recent threads". */
export function orderModel<T extends StripThread>(
  model: HeaderModel<T>,
  order: readonly string[],
): HeaderModel<T> {
  const drawn = stripChips(model);
  const byId = new Map(drawn.map((chip) => [chip.id, chip]));
  return {
    live: orderChips(order, drawn).map((id) => byId.get(id)!),
    dormant: drawn === model.live ? model.dormant : model.dormant.filter((c) => c.id !== model.activeId),
    activeId: model.activeId,
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

/** Strip order for next/previous: the live row, then the shelf. */
export function headerOrder<T extends StripThread>(model: HeaderModel<T>): HeaderChip<T>[] {
  return [...model.live, ...model.dormant];
}

/** The chip that takes selection when `id` leaves the strip: its nearest
 *  neighbour in strip order, or null when it was the last one. */
export function headerNeighbour<T extends StripThread>(
  model: HeaderModel<T>,
  id: string,
): HeaderChip<T> | null {
  const order = headerOrder(model);
  const at = order.findIndex((c) => c.id === id);
  const rest = order.filter((c) => c.id !== id);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(at, 0), rest.length - 1)];
}

/** Session id → the first tab that holds it. A thread on several tabs
 *  belongs to the first in tab order. */
function tabIndex(tabs: readonly HeaderTab[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const tab of tabs)
    for (const id of tab.sessionIds) if (!out.has(id)) out.set(id, tab.id);
  return out;
}
