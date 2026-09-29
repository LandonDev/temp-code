import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { perfMark } from "../lib/perfMarks";
import {
  loadProjectRailOpen,
  loadSidebarOpen,
  loadSidebarTabOrder,
  saveProjectRailOpen,
  saveSidebarOpen,
  type SidebarLayout,
  type SidebarTabId,
} from "../lib/appearance";
import {
  loadNotesEnabled,
  loadSettingsSection,
  saveSettingsSection,
  type SettingsSectionId,
} from "../lib/settings";
import type { InstalledUpdate } from "../lib/updateNotice";

/**
 * The window chrome's own state: which panels and full-screen views are open,
 * which sidebar tab shows, which dialogs are up. Written by clicks and
 * shortcuts, so rarely; read by the chrome through selectors, so a change
 * here re-renders the piece that shows it and nothing else.
 *
 * Every reducer returns the same object when it changes nothing, so a
 * repeated click is free and the store fires no listeners for it.
 */
export type WhatsNew = { version: string; markdown?: string };

export type ShellState = {
  sidebarOpen: boolean;
  projectRailOpen: boolean;
  sidebarTab: SidebarTabId;
  /** The files tab's search box. */
  filesSearchOpen: boolean;
  /** Bumped to move focus into the files search box. */
  searchFocusToken: number;
  searchViewOpen: boolean;
  /** Bumped to move focus into the search view. */
  searchViewFocusToken: number;
  inboxViewOpen: boolean;
  notesViewOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  updateNotice: InstalledUpdate | null;
  whatsNew: WhatsNew | null;
  filePickerOpen: boolean;
  symbolPickerOpen: boolean;
  /** A folder the catalog does not know yet: the New Workspace dialog shows it. */
  newWorkspacePath: string | null;
};

export function initialShellState(
  overrides: Partial<ShellState> = {},
): ShellState {
  return {
    sidebarOpen: loadSidebarOpen(),
    projectRailOpen: loadProjectRailOpen(),
    sidebarTab: loadSidebarTabOrder()[0] ?? "sessions",
    filesSearchOpen: false,
    searchFocusToken: 0,
    searchViewOpen: false,
    searchViewFocusToken: 0,
    inboxViewOpen: false,
    notesViewOpen: false,
    settingsOpen: false,
    settingsSection: loadSettingsSection(),
    updateNotice: null,
    whatsNew: null,
    filePickerOpen: false,
    symbolPickerOpen: false,
    newWorkspacePath: null,
    ...overrides,
  };
}

/** `state` itself when every change is already in place. */
export function patch(state: ShellState, changes: Partial<ShellState>): ShellState {
  for (const key of Object.keys(changes) as (keyof ShellState)[]) {
    if (!Object.is(state[key], changes[key])) return { ...state, ...changes };
  }
  return state;
}

const VIEWS_CLOSED = {
  searchViewOpen: false,
  inboxViewOpen: false,
  notesViewOpen: false,
} as const;

/** The three full-screen views go away; whatever is under them shows. */
export function closeViews(state: ShellState): ShellState {
  return patch(state, VIEWS_CLOSED);
}

/** Views and the settings surface go away: the board is back. */
export function closeOverlays(state: ShellState): ShellState {
  return patch(state, { ...VIEWS_CLOSED, settingsOpen: false });
}

/** Back to the board with the sessions tab up, for a thread that just started. */
export function leaveToSessions(state: ShellState): ShellState {
  return patch(state, { ...VIEWS_CLOSED, sidebarTab: "sessions" });
}

/** The sidebar comes forward on the given tab. */
export function showSidebarTab(state: ShellState, tab: SidebarTabId): ShellState {
  return patch(state, { sidebarOpen: true, sidebarTab: tab });
}

export function toggleSidebar(state: ShellState, layout: SidebarLayout): ShellState {
  return layout === "deck"
    ? patch(state, { projectRailOpen: !state.projectRailOpen })
    : patch(state, { sidebarOpen: !state.sidebarOpen });
}

export function toggleProjectRail(state: ShellState): ShellState {
  return patch(state, { projectRailOpen: !state.projectRailOpen });
}

export function openFilePicker(state: ShellState): ShellState {
  return patch(state, { ...VIEWS_CLOSED, filePickerOpen: true });
}

export function openSymbolPicker(state: ShellState): ShellState {
  return patch(state, { ...VIEWS_CLOSED, filePickerOpen: false, symbolPickerOpen: true });
}

/** Find in project: the files tab with its search box focused. */
export function openFilesSearch(state: ShellState): ShellState {
  return {
    ...state,
    ...VIEWS_CLOSED,
    sidebarOpen: true,
    sidebarTab: "files",
    filesSearchOpen: true,
    searchFocusToken: state.searchFocusToken + 1,
  };
}

export function openSearchView(state: ShellState): ShellState {
  return {
    ...state,
    filePickerOpen: false,
    settingsOpen: false,
    inboxViewOpen: false,
    notesViewOpen: false,
    searchViewOpen: true,
    searchViewFocusToken: state.searchViewFocusToken + 1,
  };
}

/** Deck: the inbox view. Classic: the sidebar's inbox tab. */
export function openInbox(state: ShellState, layout: SidebarLayout): ShellState {
  const base = {
    filePickerOpen: false,
    settingsOpen: false,
    searchViewOpen: false,
    notesViewOpen: false,
  };
  return layout === "deck"
    ? patch(state, { ...base, inboxViewOpen: true })
    : patch(state, { ...base, inboxViewOpen: false, sidebarOpen: true, sidebarTab: "inbox" });
}

export function openNotes(state: ShellState): ShellState {
  return patch(state, {
    filePickerOpen: false,
    settingsOpen: false,
    searchViewOpen: false,
    inboxViewOpen: false,
    notesViewOpen: true,
  });
}

export function openSettings(state: ShellState, section?: SettingsSectionId): ShellState {
  return patch(state, {
    ...VIEWS_CLOSED,
    filePickerOpen: false,
    settingsOpen: true,
    ...(section ? { settingsSection: section } : {}),
  });
}

/**
 * Back from the rail: the topmost overlay closes, settings first, then
 * search, inbox, notes. The same state when nothing was open, so the caller
 * moves through tab history instead.
 */
export function leaveTopOverlay(state: ShellState): ShellState {
  if (state.settingsOpen) return { ...state, settingsOpen: false };
  if (state.searchViewOpen) return { ...state, searchViewOpen: false };
  if (state.inboxViewOpen) return { ...state, inboxViewOpen: false };
  if (state.notesViewOpen) return { ...state, notesViewOpen: false };
  return state;
}

/**
 * The layout switched. Classic has no changes tab and hosts the inbox in the
 * sidebar, so an open inbox view moves there; deck has no inbox tab.
 */
export function applyLayoutChange(state: ShellState, layout: SidebarLayout): ShellState {
  if (layout === "classic") {
    const sidebarTab = state.inboxViewOpen
      ? "inbox"
      : state.sidebarTab === "changes"
        ? "sessions"
        : state.sidebarTab;
    return patch(
      state,
      state.inboxViewOpen
        ? { sidebarTab, inboxViewOpen: false, sidebarOpen: true }
        : { sidebarTab },
    );
  }
  return settleSidebarTab(state, layout);
}

/** A tab the current layout has no room for falls back to sessions. */
export function settleSidebarTab(state: ShellState, layout: SidebarLayout): ShellState {
  const deck = layout === "deck";
  if (!deck && state.sidebarTab === "changes") return { ...state, sidebarTab: "sessions" };
  if (deck && state.sidebarTab === "inbox") return { ...state, sidebarTab: "sessions" };
  return state;
}

export const shellStore = createStore<ShellState>()(
  subscribeWithSelector(() => initialShellState()),
);

export function useShell<T>(selector: (state: ShellState) => T): T {
  return useStore(shellStore, selector);
}

/** True while a full-screen view covers the board. */
export function anyViewOpen(state: ShellState): boolean {
  return state.searchViewOpen || state.inboxViewOpen || state.notesViewOpen;
}

// The panel choices survive a relaunch; the rest is per window.
shellStore.subscribe((state) => state.sidebarOpen, (open) => saveSidebarOpen(open));
shellStore.subscribe((state) => state.projectRailOpen, (open) => saveProjectRailOpen(open));
shellStore.subscribe((state) => state.settingsSection, (section) => saveSettingsSection(section));

const update = (reducer: (state: ShellState) => ShellState) =>
  shellStore.setState(reducer);

/** The bound actions: each applies a reducer above to the live store. */
export const shell = {
  closeViews: () => update(closeViews),
  closeOverlays: () => update(closeOverlays),
  leaveToSessions: () => update(leaveToSessions),
  showSidebarTab: (tab: SidebarTabId) => update((s) => showSidebarTab(s, tab)),
  setSidebarTab: (tab: SidebarTabId) => update((s) => patch(s, { sidebarTab: tab })),
  setFilesSearchOpen: (open: boolean) => update((s) => patch(s, { filesSearchOpen: open })),
  /** Takes the window's own layout: storage may already hold another window's. */
  toggleSidebar: (layout: SidebarLayout) => update((s) => toggleSidebar(s, layout)),
  toggleProjectRail: () => update(toggleProjectRail),
  openFilePicker: () => update(openFilePicker),
  closeFilePicker: () => update((s) => patch(s, { filePickerOpen: false })),
  openSymbolPicker: () => update(openSymbolPicker),
  closeSymbolPicker: () => update((s) => patch(s, { symbolPickerOpen: false })),
  openFilesSearch: () => update(openFilesSearch),
  openSearchView: () => {
    perfMark("page-switch", "search");
    update(openSearchView);
  },
  closeSearchView: () => update((s) => patch(s, { searchViewOpen: false })),
  openInbox: (layout: SidebarLayout) => {
    perfMark("page-switch", "inbox");
    update((s) => openInbox(s, layout));
  },
  closeInbox: () => update((s) => patch(s, { inboxViewOpen: false })),
  openNotes: () => {
    if (!loadNotesEnabled()) return;
    update(openNotes);
  },
  closeNotes: () => update((s) => patch(s, { notesViewOpen: false })),
  openSettings: (section?: SettingsSectionId) => {
    perfMark("page-switch", "settings");
    update((s) => openSettings(s, section));
  },
  closeSettings: () => update((s) => patch(s, { settingsOpen: false })),
  selectSettingsSection: (section: SettingsSectionId) =>
    update((s) => patch(s, { settingsSection: section })),
  /** True when an overlay closed; false means tab history is next. */
  leaveTopOverlay: (): boolean => {
    const before = shellStore.getState();
    update(leaveTopOverlay);
    return shellStore.getState() !== before;
  },
  applyLayoutChange: (layout: SidebarLayout) => update((s) => applyLayoutChange(s, layout)),
  settleSidebarTab: (layout: SidebarLayout) => update((s) => settleSidebarTab(s, layout)),
  setUpdateNotice: (notice: InstalledUpdate | null) =>
    update((s) => patch(s, { updateNotice: notice })),
  dismissUpdate: () => update((s) => patch(s, { updateNotice: null })),
  showWhatsNew: (whatsNew: WhatsNew) => update((s) => patch(s, { whatsNew })),
  dismissWhatsNew: () => update((s) => patch(s, { whatsNew: null })),
  setNewWorkspacePath: (path: string | null) =>
    update((s) => patch(s, { newWorkspacePath: path })),
};
