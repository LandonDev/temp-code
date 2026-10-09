import { inboxItemKey, type InboxItem } from "./githubTasks";
import { applyInboxFilters, loadInboxFilters } from "./inboxFilters";
import {
  inboxHasUnseenItems,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "./inboxSeen";
import { inboxItemsFromSnapshot, inboxStore } from "./inboxStore";
import { workspaceStore } from "./tcserver/workspaces";

/**
 * The rail's inbox dot. It reads the stored GitHub snapshot (loaded from
 * SQLite when the socket opens) and the Linear list the open inbox last
 * fetched, and never asks the server to fetch: a closed inbox costs
 * nothing, and the dot is right at launch from the last stored snapshot.
 */

let badge: boolean | null = null;

export function inboxSeenEntries(
  items: readonly Parameters<typeof inboxItemKey>[0][],
): InboxSeenEntry[] {
  return items.map((item) => ({
    key: inboxItemKey(item),
    updatedAt: item.updatedAt,
  }));
}

function storedItems(): InboxItem[] {
  const { github, linear } = inboxStore.getSnapshot();
  const catalog = workspaceStore.getSnapshot();
  return [
    ...inboxItemsFromSnapshot(github, catalog.workspaces, catalog.projects, ""),
    ...linear.items,
  ];
}

function cachedEntries(): InboxSeenEntry[] {
  return inboxSeenEntries(applyInboxFilters(storedItems(), loadInboxFilters(), ""));
}

export function inboxUnseenFromCache(): boolean {
  if (badge === null) badge = inboxHasUnseenItems(cachedEntries());
  return badge;
}

/** Recomputes on a new snapshot, a catalog change, or a seen mark; the first stored list seeds "seen". */
export function subscribeInboxBadge(listener: () => void): () => void {
  const recompute = () => {
    badge = null;
    listener();
  };
  const onList = () => {
    seedInboxSeenIfNeeded(cachedEntries());
    recompute();
  };
  const offInbox = inboxStore.subscribe(onList);
  const offCatalog = workspaceStore.subscribe(onList);
  const offSeen = subscribeInboxSeen(recompute);
  return () => {
    offInbox();
    offCatalog();
    offSeen();
  };
}

/** Test seam. */
export function resetInboxBadge() {
  badge = null;
}
