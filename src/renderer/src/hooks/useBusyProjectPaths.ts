import { useMemo, useSyncExternalStore } from "react";
import { workspacePathOfSession } from "../lib/projectContext";
import { sessionStore } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";

/**
 * Workspace folders with a turn in flight, for the rail's busy dots. Reads
 * the store through a string key so a streamed turn that changes nothing
 * about which projects are busy re-renders nothing.
 */
export function useBusyProjectPaths(): string[] {
  const catalog = useWorkspaceCatalog();
  const key = useSyncExternalStore(sessionStore.subscribe, () => {
    const paths = new Set<string>();
    for (const session of sessionStore.getSnapshot()) {
      if (!session.busy) continue;
      const path = workspacePathOfSession(session, catalog);
      if (path) paths.add(path);
    }
    return [...paths].sort().join("\n");
  });
  return useMemo(() => (key ? key.split("\n") : []), [key]);
}
