export type SidebarVisibilityInput = {
  /** The shell is open at all: deck layout, or the classic sidebar/settings toggled on. */
  open: boolean;
  deckLayout: boolean;
  inProject: boolean;
  atHome: boolean;
  searchActive: boolean;
  inboxActive: boolean;
  notesActive: boolean;
  accountsPage: boolean;
  settingsOpen: boolean;
};

/**
 * Whether the middle aside (sessions, files, changes) shows. The full-window
 * views cover it in either layout: search, inbox, notes and the Aliax pages
 * fill everything right of the rail. Classic settings keep it so it can host
 * the section nav the rail would otherwise carry; deck settings stand alone.
 * A blank deck session has no project to browse, so the shell stands alone
 * until one is picked.
 */
export function sidebarVisible(a: SidebarVisibilityInput): boolean {
  if (!a.open || a.searchActive || a.inboxActive || a.notesActive || a.accountsPage) return false;
  if (a.settingsOpen) return !a.deckLayout;
  return !(a.deckLayout && !a.inProject && !a.atHome);
}
