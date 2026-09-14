import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { loadSidebarLayout } from "../lib/appearance";
import { leafIds, type WorkspaceTab } from "../lib/layout";
import {
  emptyTabVisitHistory,
  pruneTabVisitHistory,
  recordTabVisit,
  tabVisitBack,
  tabVisitForward,
  type TabVisitHistory,
} from "../lib/tabVisitHistory";
import { mountTab, trimMounted, warmTabIds } from "../lib/warmTabs";

/**
 * The window's open tabs: which one is active, the back/forward trail of
 * visits, and which tabs currently have their panes mounted. The
 * `WorkspaceTab` shape is `lib/layout`'s; this store only holds the array.
 * (`lib/tcserver/workspaces` is the server's workspace catalog; this is the
 * window's workspace.)
 */
export type WorkspaceTabsState = {
  tabs: WorkspaceTab[];
  activeTabId: string;
  /** Back/forward trail of active tab ids, pruned to the open tabs. */
  visits: TabVisitHistory;
  /** The next activation came from the trail itself, so it is not recorded. */
  visitFromHistory: boolean;
  /**
   * Tabs whose pane trees are on the page. The active tab joins at once;
   * the rest leave once they have been parked for `PARK_MS`, down to the
   * warm set (`lib/warmTabs`). Never a tab that is not open.
   */
  mountedTabIds: readonly string[];
};

export type Updater<T> = T | ((prev: T) => T);

export function initialWorkspaceTabsState(
  tabs: WorkspaceTab[] = [],
  activeTabId = tabs[0]?.id ?? "",
): WorkspaceTabsState {
  return {
    tabs,
    activeTabId,
    visits: emptyTabVisitHistory(activeTabId),
    visitFromHistory: false,
    mountedTabIds: activeTabId ? [activeTabId] : [],
  };
}

function resolve<T>(update: Updater<T>, prev: T): T {
  return typeof update === "function" ? (update as (prev: T) => T)(prev) : update;
}

function sameHistory(a: TabVisitHistory, b: TabVisitHistory): boolean {
  return (
    a.current === b.current &&
    a.back.length === b.back.length &&
    a.forward.length === b.forward.length &&
    a.back.every((id, i) => id === b.back[i]) &&
    a.forward.every((id, i) => id === b.forward[i])
  );
}

// Reducers. Each returns `state` itself when nothing changes, so a
// `setState(reducer)` that changes nothing wakes no subscriber.

export function setTabs(
  state: WorkspaceTabsState,
  update: Updater<WorkspaceTab[]>,
): WorkspaceTabsState {
  const tabs = resolve(update, state.tabs);
  return tabs === state.tabs ? state : { ...state, tabs };
}

export function setActiveTabId(
  state: WorkspaceTabsState,
  update: Updater<string>,
): WorkspaceTabsState {
  const activeTabId = resolve(update, state.activeTabId);
  return activeTabId === state.activeTabId ? state : { ...state, activeTabId };
}

/**
 * Bring the trail up to date with the open tabs and the active one: closed
 * tabs drop out, and a fresh activation is recorded unless it came from the
 * trail itself. Runs after every tabs/active change.
 */
export function settleVisits(state: WorkspaceTabsState): WorkspaceTabsState {
  const openIds = new Set(state.tabs.map((tab) => tab.id));
  let next = pruneTabVisitHistory(state.visits, openIds, state.activeTabId);
  if (!state.visitFromHistory && next.current !== state.activeTabId) {
    next = recordTabVisit(next, state.activeTabId);
  }
  next = pruneTabVisitHistory(next, openIds, state.activeTabId);
  const visits = sameHistory(next, state.visits) ? state.visits : next;
  if (visits === state.visits && !state.visitFromHistory) return state;
  return { ...state, visits, visitFromHistory: false };
}

/** Step the trail; the caller activates the returned tab. Null when there is nowhere to go. */
export function stepVisits(
  state: WorkspaceTabsState,
  direction: "back" | "forward",
): { state: WorkspaceTabsState; tabId: string | null } {
  const openIds = new Set(state.tabs.map((tab) => tab.id));
  const pruned = pruneTabVisitHistory(state.visits, openIds, state.activeTabId);
  const next = direction === "back" ? tabVisitBack(pruned) : tabVisitForward(pruned);
  if (!next || !openIds.has(next.current)) return { state, tabId: null };
  return {
    state: { ...state, visits: next, visitFromHistory: true },
    tabId: next.current,
  };
}

/** The active tab's panes mount now; closed tabs leave the mounted set. */
export function mountActiveTab(state: WorkspaceTabsState): WorkspaceTabsState {
  const open = state.tabs.map((tab) => tab.id);
  const mountedTabIds = mountTab(trimMounted(state.mountedTabIds, open), state.activeTabId);
  return mountedTabIds === state.mountedTabIds ? state : { ...state, mountedTabIds };
}

/** Parked tabs outside the warm set unmount; the active tab always stays. */
export function trimMountedTabs(state: WorkspaceTabsState): WorkspaceTabsState {
  const warm = warmTabIds(state.tabs, state.activeTabId, state.visits);
  const mountedTabIds = mountTab(trimMounted(state.mountedTabIds, warm), state.activeTabId);
  return mountedTabIds === state.mountedTabIds ? state : { ...state, mountedTabIds };
}

export const workspaceTabsStore = createStore<WorkspaceTabsState>()(
  subscribeWithSelector(() => initialWorkspaceTabsState()),
);

export function useWorkspaceTabs<T>(selector: (state: WorkspaceTabsState) => T): T {
  return useStore(workspaceTabsStore, selector);
}

/** The active tab as of now, for callbacks. */
export function currentActiveTab(): WorkspaceTab | undefined {
  const { tabs, activeTabId } = workspaceTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId);
}

/** Whether the sidebar is in its deck layout, as of now, for callbacks. */
export function currentDeckLayout(): boolean {
  return loadSidebarLayout() === "deck";
}

export const workspace = {
  setTabs: (update: Updater<WorkspaceTab[]>) =>
    workspaceTabsStore.setState((s) => setTabs(s, update)),
  setActiveTabId: (update: Updater<string>) =>
    workspaceTabsStore.setState((s) => setActiveTabId(s, update)),
  settleVisits: () => workspaceTabsStore.setState(settleVisits),
  /** Step back in the trail; returns the tab to activate, or null. */
  visitBack: () => step("back"),
  /** Step forward in the trail; returns the tab to activate, or null. */
  visitForward: () => step("forward"),
  mountActiveTab: () => workspaceTabsStore.setState(mountActiveTab),
  trimMountedTabs: () => workspaceTabsStore.setState(trimMountedTabs),
};

function step(direction: "back" | "forward"): string | null {
  const { state, tabId } = stepVisits(workspaceTabsStore.getState(), direction);
  if (tabId) workspaceTabsStore.setState(state);
  return tabId;
}

/**
 * The tab on screen and the session it shows: the focused pane's session,
 * else the first pane that is one. Callbacks and subscriptions read it off
 * the stores through `currentActiveSession()`; App's render computes the
 * same from its live values.
 */
export function activeSessionOf<S extends { id: string }>(
  tabs: WorkspaceTab[],
  activeTabId: string,
  sessions: S[],
): { activeTab: WorkspaceTab | undefined; active: S | undefined } {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const active =
    sessions.find((session) => session.id === activeTab?.focusedId) ??
    sessions.find(
      (session) => activeTab && leafIds(activeTab.layout).includes(session.id),
    );
  return { activeTab, active };
}
