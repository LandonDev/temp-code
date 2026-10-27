import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { perfMark } from "../lib/perfMarks";
import { loadProjectRailOpen, saveProjectRailOpen } from "../lib/appearance";
import {
  loadNotesEnabled,
  loadSettingsSection,
  saveSettingsSection,
  type SettingsSectionId,
} from "../lib/settings";
import type { InstalledUpdate } from "../lib/updateNotice";

/**
 * The window chrome's own state: which panels and full-screen views are open,
 * which dialogs are up. Written by clicks and
 * shortcuts, so rarely; read by the chrome through selectors, so a change
 * here re-renders the piece that shows it and nothing else.
 *
 * Every reducer returns the same object when it changes nothing, so a
 * repeated click is free and the store fires no listeners for it.
 */
export type WhatsNew = { version: string; markdown?: string };

/** The embedded Aliax pages, reached from the rail's Accounts section. */
export type AliaxPageId = "accounts" | "stats";

export type ShellState = {
  projectRailOpen: boolean;
  searchViewOpen: boolean;
  /** Bumped to move focus into the search view. */
  searchViewFocusToken: number;
  /** The query the search view opens with (Find in project: `type:file `); null keeps its own. */
  searchSeed: string | null;
  inboxViewOpen: boolean;
  notesViewOpen: boolean;
  /** The Aliax page covering the board, if one is open. */
  accountsPage: AliaxPageId | null;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  updateNotice: InstalledUpdate | null;
  whatsNew: WhatsNew | null;
  filePickerOpen: boolean;
  symbolPickerOpen: boolean;
  /** A folder the catalog does not know yet: the New Workspace dialog shows it. */
  newWorkspacePath: string | null;
  /** The machine that folder is on; this one when null. */
  newWorkspaceEnvironmentId: string | null;
};

export function initialShellState(
  overrides: Partial<ShellState> = {},
): ShellState {
  return {
    projectRailOpen: loadProjectRailOpen(),
    searchViewOpen: false,
    searchViewFocusToken: 0,
    searchSeed: null,
    inboxViewOpen: false,
    notesViewOpen: false,
    accountsPage: null,
    settingsOpen: false,
    settingsSection: loadSettingsSection(),
    updateNotice: null,
    whatsNew: null,
    filePickerOpen: false,
    symbolPickerOpen: false,
    newWorkspacePath: null,
    newWorkspaceEnvironmentId: null,
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
  accountsPage: null,
} as const;

/** The full-screen views go away; whatever is under them shows. */
export function closeViews(state: ShellState): ShellState {
  return patch(state, VIEWS_CLOSED);
}

/** Views and the settings surface go away: the board is back. */
export function closeOverlays(state: ShellState): ShellState {
  return patch(state, { ...VIEWS_CLOSED, settingsOpen: false });
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

/** Find in project: the search view, seeded with the file filter. */
export function openFilesSearch(state: ShellState): ShellState {
  return { ...openSearchView(state), searchSeed: "type:file " };
}

export function openSearchView(state: ShellState): ShellState {
  return {
    ...state,
    filePickerOpen: false,
    settingsOpen: false,
    inboxViewOpen: false,
    notesViewOpen: false,
    accountsPage: null,
    searchViewOpen: true,
    searchViewFocusToken: state.searchViewFocusToken + 1,
    searchSeed: null,
  };
}

export function openInbox(state: ShellState): ShellState {
  return patch(state, {
    filePickerOpen: false,
    settingsOpen: false,
    searchViewOpen: false,
    notesViewOpen: false,
    accountsPage: null,
    inboxViewOpen: true,
  });
}

export function openNotes(state: ShellState): ShellState {
  return patch(state, {
    filePickerOpen: false,
    settingsOpen: false,
    searchViewOpen: false,
    inboxViewOpen: false,
    accountsPage: null,
    notesViewOpen: true,
  });
}

/** One of the Aliax pages covers the board. */
export function openAccountsPage(state: ShellState, page: AliaxPageId): ShellState {
  return patch(state, {
    ...VIEWS_CLOSED,
    filePickerOpen: false,
    settingsOpen: false,
    accountsPage: page,
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
  if (state.accountsPage) return { ...state, accountsPage: null };
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
  return (
    state.searchViewOpen || state.inboxViewOpen || state.notesViewOpen || state.accountsPage !== null
  );
}

// The panel choices survive a relaunch; the rest is per window.
shellStore.subscribe((state) => state.projectRailOpen, (open) => saveProjectRailOpen(open));
shellStore.subscribe((state) => state.settingsSection, (section) => saveSettingsSection(section));

const update = (reducer: (state: ShellState) => ShellState) =>
  shellStore.setState(reducer);

/** The bound actions: each applies a reducer above to the live store. */
export const shell = {
  closeViews: () => update(closeViews),
  closeOverlays: () => update(closeOverlays),
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
  openInbox: () => {
    perfMark("page-switch", "inbox");
    update(openInbox);
  },
  closeInbox: () => update((s) => patch(s, { inboxViewOpen: false })),
  openNotes: () => {
    if (!loadNotesEnabled()) return;
    update(openNotes);
  },
  closeNotes: () => update((s) => patch(s, { notesViewOpen: false })),
  openAccountsPage: (page: AliaxPageId) => {
    perfMark("page-switch", page);
    update((s) => openAccountsPage(s, page));
  },
  closeAccountsPage: () => update((s) => patch(s, { accountsPage: null })),
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
  setUpdateNotice: (notice: InstalledUpdate | null) =>
    update((s) => patch(s, { updateNotice: notice })),
  dismissUpdate: () => update((s) => patch(s, { updateNotice: null })),
  showWhatsNew: (whatsNew: WhatsNew) => update((s) => patch(s, { whatsNew })),
  dismissWhatsNew: () => update((s) => patch(s, { whatsNew: null })),
  setNewWorkspacePath: (path: string | null, environmentId: string | null = null) =>
    update((s) => patch(s, { newWorkspacePath: path, newWorkspaceEnvironmentId: path ? environmentId : null })),
};
