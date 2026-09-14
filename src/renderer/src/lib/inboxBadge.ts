import { inboxItemKey, peekLastInboxList, subscribeInboxList } from "./githubTasks";
import { applyInboxFilters, loadInboxFilters } from "./inboxFilters";
import {
  inboxHasUnseenItems,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "./inboxSeen";

/**
 * The rail's inbox dot. It reads the last list the open inbox fetched and
 * never asks the server for anything: a closed inbox costs nothing, and the
 * dot only changes once the user has opened the inbox and a fetch landed.
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

function cachedEntries(): InboxSeenEntry[] {
  const listed = peekLastInboxList();
  if (!listed) return [];
  return inboxSeenEntries(applyInboxFilters(listed.items, loadInboxFilters(), ""));
}

export function inboxUnseenFromCache(): boolean {
  if (badge === null) badge = inboxHasUnseenItems(cachedEntries());
  return badge;
}

/** Recomputes on a new list or a seen mark; the first list seeds "seen". */
export function subscribeInboxBadge(listener: () => void): () => void {
  const recompute = () => {
    badge = null;
    listener();
  };
  const onList = () => {
    seedInboxSeenIfNeeded(cachedEntries());
    recompute();
  };
  const offList = subscribeInboxList(onList);
  const offSeen = subscribeInboxSeen(recompute);
  return () => {
    offList();
    offSeen();
  };
}

/** Test seam. */
export function resetInboxBadge() {
  badge = null;
}
