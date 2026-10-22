import { useDevRunning, useDevServable } from "../lib/devServers";
import { showDevRail } from "../lib/railPanel";
import { useSyncExternalStore } from "react";
import { sessionStore } from "../lib/tcserver/store";
import { useProjects } from "../lib/tcserver/workspaces";

/**
 * "Dev server" in the thread header (docs/box.md "Dev servers on the box"):
 * shown only when a host can serve the thread's project (a dev script, an
 * Expo app, an Xcode project), with a dot while one of its servers runs.
 * It opens the rail's Dev tab, where the target, the host and the console
 * live; the button itself never starts anything.
 */
export function DevServerButton({ sessionId }: { sessionId: string }) {
  // The thread's project and host only: a streaming turn must not re-render the header.
  const where = useSyncExternalStore(sessionStore.subscribe, () => {
    const s = sessionStore.get(sessionId);
    return s?.projectId ? `${s.environmentId}|${s.projectId}` : "";
  });
  const [environmentId, projectId] = where.split("|");
  const project = useProjects().find((p) => p.id === projectId && p.environmentId === environmentId);
  const servable = useDevServable(project);
  const running = useDevRunning(project?.id);
  if (!project || (!servable && !running)) return null;
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      data-dev-server-button={running ? "running" : "idle"}
      onClick={showDevRail}
      className="pressable flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/50 hover:bg-content/5 hover:text-content"
    >
      {running ? <span className="size-1.5 rounded-full bg-success" aria-label="Running" /> : null}
      Dev server
    </button>
  );
}
