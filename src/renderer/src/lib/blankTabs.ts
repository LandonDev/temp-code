import { leafIds, type WorkspaceTab } from "./layout";
import { HARNESS_LABEL, type Session } from "./session";

/**
 * Titles a thread carries until its first message: the server's per-type
 * placeholders, its `provider · agentType` fallback, and the renderer's
 * draft label. The first send replaces the title with a slice of the
 * message, so a placeholder title on an unloaded thread means no message
 * ever went in.
 */
const PLACEHOLDER_TITLES = new Set([
  "New chat",
  "New plan",
  "New task",
  "New orchestration",
  "New research",
  ...Object.values(HARNESS_LABEL),
]);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title) || /^[a-z]+ · [a-z_-]+$/i.test(title);
}

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
 * in the database and the sidebar. Returns the same array when nothing
 * drops.
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
