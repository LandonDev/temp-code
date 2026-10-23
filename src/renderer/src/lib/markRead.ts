import type { Catalog } from "./projectContext";
import type { SessionMeta } from "./tcserver/types";
import { workspacePathOfSession } from "./projectContext";
import { sameProjectPath } from "./recents";
import { housedIds } from "./workspaceSessions";

/**
 * What "Mark all read" marks: every unarchived thread the rail could show as
 * unread, with its subagents, on one workspace (`path`), on a workspace's
 * copies across hosts (several paths) or everywhere (`null`). The stamp is
 * the newest updatedAt among them or now, whichever is later, so a server
 * clock ahead of this machine's cannot leave a thread lit. A thread inside a
 * master (`housedIds`) is never unread, so it is never marked or counted.
 */
export function threadsToMarkRead(
  metas: readonly SessionMeta[],
  catalog: Catalog,
  path: string | readonly string[] | null,
  now = Date.now(),
): { ids: string[]; at: number } {
  const ids: string[] = [];
  let at = now;
  const paths = path === null ? null : typeof path === "string" ? [path] : path;
  const housed = housedIds(metas);
  for (const meta of metas) {
    if (meta.archived || housed.has(meta.id)) continue;
    if (paths !== null) {
      const home = workspacePathOfSession(meta, catalog);
      if (!paths.some((p) => sameProjectPath(home, p))) continue;
    }
    ids.push(meta.id);
    if (meta.updatedAt > at) at = meta.updatedAt;
  }
  return { ids, at };
}

/** The same for every unarchived thread on one host. */
export function threadsToMarkReadOnHost(
  metas: readonly SessionMeta[],
  environmentId: string,
  now = Date.now(),
): { ids: string[]; at: number } {
  const ids: string[] = [];
  let at = now;
  const housed = housedIds(metas);
  for (const meta of metas) {
    if (meta.archived || housed.has(meta.id) || meta.environmentId !== environmentId) continue;
    ids.push(meta.id);
    if (meta.updatedAt > at) at = meta.updatedAt;
  }
  return { ids, at };
}
