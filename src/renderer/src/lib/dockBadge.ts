import type { SessionMeta } from "./tcserver/types";
import { threadStateOf } from "../components/ui/status";
import { invoke } from "./native";
import { sessionStore } from "./tcserver/store";

let lastCount = -1;

/** The Dock badge counts threads that need you — an approval or a question —
 *  on every host, subagents included, archived out. Nothing else counts:
 *  not unread, not failed, not a plan ready to start. */
export function needsYouCount(metas: Iterable<Pick<SessionMeta, "status" | "archived">>): number {
  let count = 0;
  for (const meta of metas) {
    if (!meta.archived && threadStateOf(meta.status) === "waiting") count++;
  }
  return count;
}

export function syncDockBadge(): void {
  const count = needsYouCount(sessionStore.metas());
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch((err) => {
    console.error("[dock] badge update failed:", err);
  });
}
