export type SidebarVisibilityInput = {
  inProject: boolean;
  atHome: boolean;
  searchActive: boolean;
  inboxActive: boolean;
  notesActive: boolean;
  accountsPage: boolean;
  settingsOpen: boolean;
};

/**
 * Whether the workspace column (its threads) shows. The full-window views
 * cover it: search, inbox, notes, the Aliax pages and settings fill
 * everything right of the rail. A blank session has no workspace to list,
 * so the shell stands alone until one is picked; the home lists its chats.
 */
export function sidebarVisible(a: SidebarVisibilityInput): boolean {
  if (a.searchActive || a.inboxActive || a.notesActive || a.accountsPage || a.settingsOpen) return false;
  return a.inProject || a.atHome;
}
