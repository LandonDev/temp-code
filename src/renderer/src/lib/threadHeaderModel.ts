import { neighbourAfterArchive } from "./threadStrip";
import {
  chipTone,
  displayStatus,
  isUnread,
  projectRootThreads,
  splitThreads,
  type ChipTone,
  type ReadyMap,
  type SeenMap,
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
  status: SessionStatus;
  unread: boolean;
  tone: ChipTone;
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
  selectedProjectId: string | null;
  activeTabId: string | null;
  lastSeen: SeenMap;
  planReady: ReadyMap;
}): HeaderModel<T> {
  const roots = projectRootThreads(input.threads, input.selectedProjectId);
  const tabOf = tabIndex(input.tabs);
  const { live, dormant } = splitThreads(roots, input.lastSeen, input.planReady);
  const chip = (thread: T, isLive: boolean): HeaderChip<T> => {
    const status = displayStatus(thread);
    const unread = isUnread(thread, input.lastSeen);
    return {
      id: thread.id,
      thread,
      tabId: tabOf.get(thread.id) ?? null,
      live: isLive,
      status,
      unread,
      tone: chipTone(status, unread),
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

/** Strip order for next/previous: the live row, then the shelf. */
export function headerOrder<T extends StripThread>(model: HeaderModel<T>): HeaderChip<T>[] {
  return [...model.live, ...model.dormant];
}

/** The chip that takes selection when `id` leaves the strip. */
export function headerNeighbour<T extends StripThread>(
  model: HeaderModel<T>,
  id: string,
): HeaderChip<T> | null {
  return neighbourAfterArchive(
    headerOrder(model).map((c) => ({ ...c, dormant: !c.live })),
    id,
  );
}

/** Session id → the first tab that holds it. A thread on several tabs
 *  belongs to the first in tab order. */
function tabIndex(tabs: readonly HeaderTab[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const tab of tabs)
    for (const id of tab.sessionIds) if (!out.has(id)) out.set(id, tab.id);
  return out;
}

/** Pause All's button copy, from its last outcome. */
export type PauseAllState = "idle" | "busy" | "failed";

export function pauseAllLabel(state: PauseAllState): string {
  if (state === "busy") return "Pausing…";
  if (state === "failed") return "Pause failed — retry";
  return "Pause all";
}
