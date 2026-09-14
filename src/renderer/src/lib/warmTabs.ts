import type { WorkspaceTab } from "./layout";
import type { TabVisitHistory } from "./tabVisitHistory";

/** Recently active tabs kept mounted behind the active one. */
export const WARM_TABS = 2;
/** How long a tab stays mounted after it leaves the warm set. */
export const PARK_MS = 3000;

/**
 * The tabs whose panes should stay mounted: the active tab, the
 * `keep` most recently active others, and every tab whose panes hold
 * state only the DOM has (a terminal's scrollback, an editor's buffer).
 * Order: active first, then most recent first.
 */
export function warmTabIds(
  tabs: readonly WorkspaceTab[],
  activeTabId: string,
  visits: TabVisitHistory,
  keep = WARM_TABS,
): string[] {
  const open = new Set(tabs.map((tab) => tab.id));
  const warm: string[] = [];
  const add = (id: string) => {
    if (open.has(id) && !warm.includes(id)) warm.push(id);
  };
  add(activeTabId);
  let recent = 0;
  for (const id of [...visits.back].reverse().concat(visits.forward)) {
    if (recent >= keep) break;
    if (!open.has(id) || warm.includes(id)) continue;
    warm.push(id);
    recent++;
  }
  for (const tab of tabs) {
    if (tab.editorPanes.length > 0 || (tab.terminalPanes?.length ?? 0) > 0) add(tab.id);
  }
  return warm;
}

/** `mounted` plus `id`; the same array when it is already there. */
export function mountTab(mounted: readonly string[], id: string): readonly string[] {
  return !id || mounted.includes(id) ? mounted : [...mounted, id];
}

/** `mounted` narrowed to `keep`; the same array when nothing drops. */
export function trimMounted(
  mounted: readonly string[],
  keep: readonly string[],
): readonly string[] {
  const kept = mounted.filter((id) => keep.includes(id));
  return kept.length === mounted.length ? mounted : kept;
}
