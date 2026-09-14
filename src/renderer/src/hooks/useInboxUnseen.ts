import { useSyncExternalStore } from "react";
import { inboxUnseenFromCache, subscribeInboxBadge } from "../lib/inboxBadge";

/**
 * Whether the last fetched inbox list holds anything the user has not seen.
 * A read of the cache only: fetching happens in the open Inbox view, never
 * here, so a closed inbox never spawns a `gh` process.
 */
export function useInboxUnseen(): boolean {
  return useSyncExternalStore(
    subscribeInboxBadge,
    inboxUnseenFromCache,
    inboxUnseenFromCache,
  );
}
