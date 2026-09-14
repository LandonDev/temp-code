/**
 * The app's one prefetcher, bound to the session store and the socket
 * (`lib/hoverPrefetch` holds the policy). Tabs resolve to the sessions in
 * their layout so a hovered split pane warms every conversation in it.
 */
import { leafIds } from "./layout";
import { Prefetcher, bootWarmTabs, whenIdle } from "./hoverPrefetch";
import { client } from "./tcserver/client";
import { sessionStore } from "./tcserver/store";
import { workspaceTabsStore } from "../stores/workspace";

export const sessionPrefetch = new Prefetcher({
  load: (id) => sessionStore.ensureLoaded(id),
  isLoaded: (id) => sessionStore.get(id)?.loaded === true,
  connected: () => client.connected,
});

/** The sessions a workspace tab shows; none for a tab that is not open. */
export function tabSessionIds(tabId: string): string[] {
  const tab = workspaceTabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab ? leafIds(tab.layout) : [];
}

/** Boot: once the active tab's sessions are in and painted, warm the two
 *  most recently used tabs in an idle slice. */
export function warmRecentTabsAtBoot(): void {
  const { tabs, activeTabId, visits } = workspaceTabsStore.getState();
  const warm = bootWarmTabs(
    tabs.map((tab) => ({
      id: tab.id,
      sessionIds: leafIds(tab.layout),
      updatedAt: sessionStore.metaOf(tab.focusedId)?.updatedAt ?? 0,
    })),
    activeTabId,
    [...visits.back].reverse(),
  );
  if (warm.length === 0) return;
  void sessionStore
    .ready()
    .then(() => Promise.all(tabSessionIds(activeTabId).map((id) => sessionStore.ensureLoaded(id))))
    .catch(() => undefined)
    .then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          whenIdle(() => {
            for (const tab of warm) for (const id of tab.sessionIds) sessionPrefetch.request(id);
          }),
        ),
      );
    });
}
