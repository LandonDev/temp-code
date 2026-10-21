import { useEffect, useMemo, useState } from "react";
import { useLastSeen, useSeenFloor, loadLastSeen, seenFloor } from "./sessionSeen";
import { useWorkspaceCatalog, workspaceStore } from "./tcserver/workspaces";
import type { BatchScope, BatchSelection } from "./threadBatch";

/** What a batch selects against, read once: for a menu's Resume all. */
export function selectionFor(scope: BatchScope): BatchSelection {
  return { catalog: workspaceStore.getSnapshot(), lastSeen: loadLastSeen(), floor: seenFloor(), scope, now: Date.now() };
}

/** The age rule moves slowly; the confirm re-reads the clock this often. */
const CLOCK_MS = 15_000;

/** The same, live: the confirm's count follows the store while it shows. */
export function useBatchSelection(scope: BatchScope): BatchSelection {
  const catalog = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const floor = useSeenFloor();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => ({ catalog, lastSeen, floor, scope, now }), [catalog, lastSeen, floor, scope, now]);
}
