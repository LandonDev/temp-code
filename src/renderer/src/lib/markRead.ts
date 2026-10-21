import type { Catalog } from "./projectContext";
import type { SessionMeta } from "./tcserver/types";
import { workspacePathOfSession } from "./projectContext";
import { sameProjectPath } from "./recents";

/**
 * What "Mark all read" marks: every unarchived thread the rail could show as
 * unread, with its subagents, on one workspace (`path`) or everywhere
 * (`null`). The stamp is the newest updatedAt among them or now, whichever
 * is later, so a server clock ahead of this machine's cannot leave a thread
 * lit.
 */
export function threadsToMarkRead(
  metas: readonly SessionMeta[],
  catalog: Catalog,
  path: string | null,
  now = Date.now(),
): { ids: string[]; at: number } {
  const ids: string[] = [];
  let at = now;
  for (const meta of metas) {
    if (meta.archived) continue;
    if (path !== null && !sameProjectPath(workspacePathOfSession(meta, catalog), path)) continue;
    ids.push(meta.id);
    if (meta.updatedAt > at) at = meta.updatedAt;
  }
  return { ids, at };
}
