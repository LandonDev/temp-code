import type { EditorPane, WorkspaceTab } from "./layout";
import { setSplitRatio } from "./layout";

/**
 * Focus updates on the tab list. Every function returns the same `tabs`
 * array when nothing changes, so a click on the already focused pane is a
 * no-op for React and nobody below App re-renders.
 */
export function focusPane(
  tabs: WorkspaceTab[],
  activeTabId: string,
  paneId: string,
): WorkspaceTab[] {
  return replaceTab(tabs, activeTabId, (tab) =>
    tab.focusedId === paneId && !tab.diffFocused
      ? tab
      : { ...tab, focusedId: paneId, diffFocused: false },
  );
}

export function focusDiff(
  tabs: WorkspaceTab[],
  activeTabId: string,
): WorkspaceTab[] {
  return replaceTab(tabs, activeTabId, (tab) =>
    tab.diffFocused ? tab : { ...tab, diffFocused: true },
  );
}

export function setTabSplitRatio(
  tabs: WorkspaceTab[],
  tabId: string,
  splitId: string,
  index: number,
  ratio: number,
): WorkspaceTab[] {
  return replaceTab(tabs, tabId, (tab) => {
    const layout = setSplitRatio(tab.layout, splitId, index, ratio);
    return layout === tab.layout ? tab : { ...tab, layout };
  });
}

function replaceTab(
  tabs: WorkspaceTab[],
  tabId: string,
  update: (tab: WorkspaceTab) => WorkspaceTab,
): WorkspaceTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return tabs;
  const next = update(tabs[index]);
  if (next === tabs[index]) return tabs;
  const copy = tabs.slice();
  copy[index] = next;
  return copy;
}

const panesByTab = new WeakMap<WorkspaceTab, EditorPane[]>();

/**
 * Editor and terminal panes as one list, cached per tab record so an
 * unchanged tab hands `PaneTree` the same array.
 */
export function tabSurfacePanes(tab: WorkspaceTab): EditorPane[] {
  let panes = panesByTab.get(tab);
  if (!panes) {
    panes = [...tab.editorPanes, ...(tab.terminalPanes ?? [])];
    panesByTab.set(tab, panes);
  }
  return panes;
}
