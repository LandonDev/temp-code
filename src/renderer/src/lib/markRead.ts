import type { Catalog } from "./projectContext";
import type { SessionMeta } from "./tcserver/types";
import { workspacePathOfSession } from "./projectContext";
import { sameProjectPath } from "./recents";

/**
 * What "Mark all read" marks: every unarchived thread the rail could show as
 * unread, with its subagents, on one workspace (`path`), on a project's
 * checkouts across hosts (several paths) or everywhere (`null`). The stamp is the newest updatedAt among them or now, whichever
 * is later, so a server clock ahead of this machine's cannot leave a thread
 * lit.
 */
export function threadsToMarkRead(
  metas: readonly SessionMeta[],
  catalog: Catalog,
  path: string | readonly string[] | null,
  now = Date.now(),
): { ids: string[]; at: number } {
  const ids: string[] = [];
  let at = now;
  // A merged project names every checkout's folder; all of them count.
  const paths = path === null ? null : typeof path === "string" ? [path] : path;
  for (const meta of metas) {
    if (meta.archived) continue;
    if (paths !== null) {
      const at = workspacePathOfSession(meta, catalog);
      if (!paths.some((p) => sameProjectPath(at, p))) continue;
    }
    ids.push(meta.id);
    if (meta.updatedAt > at) at = meta.updatedAt;
  }
  return { ids, at };
}
