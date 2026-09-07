import { invoke } from "./native";
import { sessionStore } from "./tcserver/store";

let lastCount = -1;

/** The Dock badge counts threads waiting on the user — an approval or a
 *  question — across every thread the server knows, open or not. Running
 *  and idle threads never count. */
export function waitingCount(): number {
  let count = 0;
  for (const meta of sessionStore.metas()) {
    if (meta.status === "waiting" && !meta.archived) count++;
  }
  return count;
}

export function syncDockBadge(): void {
  const count = waitingCount();
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch((err) => {
    console.error("[dock] badge update failed:", err);
  });
}
