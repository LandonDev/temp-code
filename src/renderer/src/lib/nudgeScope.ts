import { leafIds, type LayoutNode } from "./layout";
import { sameProjectPath } from "./recents";

/**
 * Whether a tool result or turn end from `sessionId`, working in `workCwd`,
 * can change anything the window shows. Seventeen background threads each
 * fire a git and file-tree refresh after every tool result; only the ones
 * whose checkout is on screen have anything to refresh. On screen means: the
 * session sits in the active tab, its checkout is the window's folder (the
 * sidebar tree and badges), or some git UI holds that checkout's index.
 */
export function nudgeReachesScreen(input: {
  sessionId: string;
  workCwd: string;
  activeTab: { focusedId: string; layout: LayoutNode } | undefined;
  projectCwd: string;
  heldCheckout: (cwd: string) => boolean;
}): boolean {
  const { sessionId, workCwd, activeTab, projectCwd, heldCheckout } = input;
  if (activeTab && (activeTab.focusedId === sessionId || leafIds(activeTab.layout).includes(sessionId))) {
    return true;
  }
  if (workCwd && workCwd !== "~" && sameProjectPath(workCwd, projectCwd)) return true;
  return heldCheckout(workCwd);
}
