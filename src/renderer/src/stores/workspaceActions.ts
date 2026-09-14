import {
  isolateTerminalPanes,
  leafIds,
  replaceLeafId,
  splitPane,
  type WorkspaceTab,
} from "../lib/layout";
import type { Session } from "../lib/session";
import {
  insertTabBesideActive,
  removeTabFromGroup,
  tabGroupProject,
  type TabProjectLookup,
} from "../lib/tabGroups";
import { focusPane as focusPaneIn } from "../lib/workspaceFocus";
import { applyBackgroundOpen } from "../lib/workspaceTabGroups";
import {
  setActiveTabId,
  setTabs,
  workspaceTabsStore,
  type WorkspaceTabsState,
} from "./workspace";

/**
 * The tab-list half of App's actions: pure functions over the tabs state.
 * Every function hands back the same `state` when it changes nothing, so a
 * store write that does nothing notifies nobody. Side effects (the server,
 * dialogs, the composer, the deck's workspace filter) stay with the caller.
 */

export function activateTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  return setActiveTabId(state, id);
}

/** Focus a pane of the active tab; the diff yields to it. */
export function focusPane(state: WorkspaceTabsState, paneId: string): WorkspaceTabsState {
  return setTabs(state, (tabs) => focusPaneIn(tabs, state.activeTabId, paneId));
}

/** A new tab lands beside the active one and inherits its group when the projects match. */
export function appendTab(
  state: WorkspaceTabsState,
  tab: WorkspaceTab,
  projectOf?: TabProjectLookup,
): WorkspaceTabsState {
  return setTabs(state, (tabs) => insertTabBesideActive(tabs, tab, state.activeTabId, projectOf));
}

/** Drop a tab. The caller picks and activates what comes next. */
export function closeTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  return setTabs(state, (tabs) =>
    tabs.some((tab) => tab.id === id) ? tabs.filter((tab) => tab.id !== id) : tabs,
  );
}

/** Bring the tab holding `sessionId` forward with that pane focused. Null when it has no pane. */
export function focusSession(
  state: WorkspaceTabsState,
  sessionId: string,
): { state: WorkspaceTabsState; tabId: string | null } {
  const tab = state.tabs.find((entry) => leafIds(entry.layout).includes(sessionId));
  if (!tab) return { state, tabId: null };
  const focused = setTabs(setActiveTabId(state, tab.id), (tabs) =>
    tab.focusedId === sessionId
      ? tabs
      : tabs.map((entry) => (entry.id === tab.id ? { ...entry, focusedId: sessionId } : entry)),
  );
  return { state: focused, tabId: tab.id };
}

/**
 * Split the pane holding `sourceId` and put `sessionId` to its right,
 * focused, in the foreground. Unchanged when no tab holds the source: the
 * caller appends a tab instead.
 */
export function splitBeside(
  state: WorkspaceTabsState,
  sourceId: string,
  sessionId: string,
): WorkspaceTabsState {
  const tab = state.tabs.find((entry) => leafIds(entry.layout).includes(sourceId));
  if (!tab) return state;
  const split = setTabs(state, (tabs) =>
    tabs.map((entry) =>
      entry.id === tab.id
        ? {
            ...entry,
            layout: splitPane(entry.layout, sourceId, "right", sessionId),
            focusedId: sessionId,
            diffFocused: false,
          }
        : entry,
    ),
  );
  return setActiveTabId(split, tab.id);
}

/** A thread joins behind the user's work; the active tab and every focus stay put. */
export function openInBackground(
  state: WorkspaceTabsState,
  session: Session,
  project: string | undefined,
  projectOf: TabProjectLookup,
): WorkspaceTabsState {
  return setTabs(
    state,
    (tabs) =>
      applyBackgroundOpen({
        tabs,
        sessions: [],
        session,
        insert: (current, tab) =>
          insertTabBesideActive(current, tab, state.activeTabId, (id) =>
            id === tab.id ? project : projectOf(id),
          ),
      }).tabs,
  );
}

/**
 * A blank pane takes `sessionId` in place and its tab comes forward. A tab
 * that does not hold the pane is left alone, activation included.
 */
export function replacePane(
  state: WorkspaceTabsState,
  tabId: string,
  paneId: string,
  sessionId: string,
): WorkspaceTabsState {
  const replaced = setTabs(state, (tabs) =>
    tabs.some((tab) => tab.id === tabId && leafIds(tab.layout).includes(paneId))
      ? tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, layout: replaceLeafId(tab.layout, paneId, sessionId), focusedId: sessionId }
            : tab,
        )
      : tabs,
  );
  return replaced === state ? state : setActiveTabId(replaced, tabId);
}

/**
 * A session's project moved in place. A group only holds tabs of one
 * project, so the tab showing that session leaves its group when the others
 * no longer match. Only the focused pane names a tab's project.
 */
export function leaveGroupIfMoved(
  state: WorkspaceTabsState,
  sessionId: string,
  project: string | undefined,
  projectOf: TabProjectLookup,
): WorkspaceTabsState {
  return setTabs(state, (tabs) => {
    const tab = tabs.find((entry) => leafIds(entry.layout).includes(sessionId));
    if (!tab?.groupId || tab.focusedId !== sessionId || !project) return tabs;
    const others = tabGroupProject(
      tabs.filter((entry) => entry.id !== tab.id),
      tab.groupId,
      projectOf,
    );
    return others && others !== project ? removeTabFromGroup(tabs, tab.id) : tabs;
  });
}

/** Terminal tabs never share a strip with files. */
export function isolateTerminals(state: WorkspaceTabsState): WorkspaceTabsState {
  return setTabs(state, (tabs) => {
    let changed = false;
    const next = tabs.map((tab) => {
      const isolated = isolateTerminalPanes(tab);
      if (isolated !== tab) changed = true;
      return isolated;
    });
    return changed ? next : tabs;
  });
}

export type ProjectTabTarget =
  | { action: "stay" }
  | { action: "activate"; tabId: string }
  | { action: "open" };

/**
 * Where a project card lands: nowhere when the active tab already shows the
 * project, else its most recently visited open tab, else the first one, else
 * the caller opens a thread.
 */
export function projectTabTarget(
  state: WorkspaceTabsState,
  sessions: readonly Pick<Session, "id" | "projectId">[],
  projectId: string,
): ProjectTabTarget {
  const inProject = (tab: WorkspaceTab) =>
    sessions.find((session) => session.id === tab.focusedId)?.projectId === projectId;
  const current = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (current && inProject(current)) return { action: "stay" };
  const recent = [...state.visits.back]
    .reverse()
    .map((id) => state.tabs.find((tab) => tab.id === id))
    .find((tab) => tab && inProject(tab));
  const target = recent ?? state.tabs.find(inProject);
  return target ? { action: "activate", tabId: target.id } : { action: "open" };
}

/** Every open pane's session id across the window's tabs. */
export function openSessionIds(tabs: readonly WorkspaceTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) for (const id of leafIds(tab.layout)) ids.add(id);
  return ids;
}

const apply = (reduce: (state: WorkspaceTabsState) => WorkspaceTabsState) =>
  workspaceTabsStore.setState(reduce);

/** The actions bound to the window's tabs store. */
export const workspaceActions = {
  activateTab: (id: string) => apply((s) => activateTab(s, id)),
  focusPane: (paneId: string) => apply((s) => focusPane(s, paneId)),
  appendTab: (tab: WorkspaceTab, projectOf?: TabProjectLookup) =>
    apply((s) => appendTab(s, tab, projectOf)),
  closeTab: (id: string) => apply((s) => closeTab(s, id)),
  focusSession: (sessionId: string): string | null => {
    let tabId: string | null = null;
    apply((s) => {
      const next = focusSession(s, sessionId);
      tabId = next.tabId;
      return next.state;
    });
    return tabId;
  },
  /** True when a pane held the source and took the split. */
  splitBeside: (sourceId: string, sessionId: string): boolean => {
    let split = false;
    apply((s) => {
      const next = splitBeside(s, sourceId, sessionId);
      split = next !== s;
      return next;
    });
    return split;
  },
  openInBackground: (session: Session, project: string | undefined, projectOf: TabProjectLookup) =>
    apply((s) => openInBackground(s, session, project, projectOf)),
  replacePane: (tabId: string, paneId: string, sessionId: string) =>
    apply((s) => replacePane(s, tabId, paneId, sessionId)),
  leaveGroupIfMoved: (
    sessionId: string,
    project: string | undefined,
    projectOf: TabProjectLookup,
  ) => apply((s) => leaveGroupIfMoved(s, sessionId, project, projectOf)),
  isolateTerminals: () => apply(isolateTerminals),
};
