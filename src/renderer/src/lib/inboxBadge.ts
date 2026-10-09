import { inboxItemKey, type InboxItem } from "./githubTasks";
import { filterInboxByWorkspace, loadInboxFilters } from "./inboxFilters";
import {
  inboxHasUnseenItems,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "./inboxSeen";
import { inboxItemsFromSnapshot, inboxNeedsAttention, inboxStore } from "./inboxStore";
import { workspaceStore } from "./tcserver/workspaces";

/**
 * The rail's inbox dot: some item that waits on the user (see
 * `inboxNeedsAttention`) has changed since they last looked at it. It
 * reads the stored GitHub snapshot (loaded from SQLite when the socket
 * opens) and the Linear list the open inbox last fetched, and never asks
 * the server to fetch: a closed inbox costs nothing, and the dot is right
 * at launch from the last stored snapshot. The list's own filters do not
 * reach the dot; only workspaces the user hid stay out of it.
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

function attentionEntries(): InboxSeenEntry[] {
  const { linear } = inboxStore.getSnapshot();
  const shown = filterInboxByWorkspace(storedItems(), loadInboxFilters().hiddenWorkspaceIds);
  return inboxSeenEntries(
    shown.filter((item) => inboxNeedsAttention(item, { linearAssignedToMe: linear.assignedToMe })),
  );
}

export function inboxUnseenFromCache(): boolean {
  if (badge === null) badge = inboxHasUnseenItems(attentionEntries());
  return badge;
}

/** Recomputes on a new snapshot, a catalog change, or a seen mark; the first stored list seeds "seen". */
export function subscribeInboxBadge(listener: () => void): () => void {
  const recompute = () => {
    badge = null;
    listener();
  };
  const onList = () => {
    // Every stored item, hidden or not, so a fresh install lights up for
    // nothing it has already got and unhiding a workspace stays quiet.
    seedInboxSeenIfNeeded(inboxSeenEntries(storedItems()));
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
