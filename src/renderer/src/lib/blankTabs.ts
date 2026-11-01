import { leafIds, type WorkspaceTab } from "./layout";
import { isPlaceholderTitle } from "@server/shared/placeholderTitles";
import type { Session } from "./session";

/**
 * Whether a restored session has nothing to show. A loaded transcript
 * answers directly; a thread the server knows but whose history is not
 * fetched yet answers by its title; a stub the server never saw is blank.
 */
export function isBlankSession(session: Session, serverKnown: boolean): boolean {
  if (session.blocks.length > 0) return false;
  if (!serverKnown || session.loaded) return true;
  return isPlaceholderTitle(session.title);
}

/** A tab that is one blank session leaf and nothing else. */
export function isBlankTab(tab: WorkspaceTab, blankIds: ReadonlySet<string>): boolean {
  if (tab.editorPanes.length > 0 || (tab.terminalPanes?.length ?? 0) > 0) return false;
  const ids = leafIds(tab.layout);
  return ids.length === 1 && blankIds.has(ids[0]!);
}

/**
 * The restore rule: at most one blank tab per project. The active tab
 * wins when it is blank; otherwise the newest (last in tab order) stays.
 * Every other blank tab leaves the restored set — the thread itself stays
 * in the database and the sidebar. Unsent drafts never reach it (the
 * restore drops them first, lib/workspaceSnapshot.ts): what it collapses
 * are threads the host knows with no message yet, and stubs it did not
 * answer for. Returns the same array when nothing drops.
 */
export function collapseBlankTabs(
  tabs: readonly WorkspaceTab[],
  blankIds: ReadonlySet<string>,
  projectOf: (sessionId: string) => string,
  activeTabId: string,
): readonly WorkspaceTab[] {
  const keep = new Map<string, WorkspaceTab>();
  for (const tab of tabs) {
    if (!isBlankTab(tab, blankIds)) continue;
    const key = projectOf(leafIds(tab.layout)[0]!);
    const current = keep.get(key);
    if (current?.id === activeTabId) continue;
    keep.set(key, tab);
  }
  const kept = new Set([...keep.values()].map((tab) => tab.id));
  const next = tabs.filter((tab) => !isBlankTab(tab, blankIds) || kept.has(tab.id));
  return next.length === tabs.length ? tabs : next;
}
