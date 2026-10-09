import type { CardThread, ProjectCardStatus } from "./projectCardModel";
import { SESSION_LIST_PAGE, sessionListWindow } from "./sessionListWindow";
import type {
  ProjectGroup,
  ThreadRow,
  WorkspaceSessionGroups,
} from "./workspaceSessions";

/**
 * The sidebar's shape as data: the list the virtualizer walks, one entry
 * per project card plus the trailing sections, and the window a card or a
 * fold shows of its rows. Pure; the component owns the "show more" counts.
 */

export type SidebarItem =
  | { kind: "project"; key: string; group: ProjectGroup }
  | { kind: "chats"; key: "chats"; threads: ThreadRow[] }
  | { kind: "accounts"; key: "accounts" }
  | { kind: "archived"; key: "archived"; groups: ProjectGroup[] }
  | { kind: "empty"; key: "empty" };

/** Cards first, then chats and archived when there are any, else the empty
 *  hint. The home has no cards to offer, so its chats section always shows.
 *  With `accounts`, the Aliax pages' section follows the chats. */
export function sidebarItems(
  groups: WorkspaceSessionGroups,
  home = false,
  accounts = false,
): SidebarItem[] {
  const items: SidebarItem[] = groups.projects.map((group) => ({
    kind: "project",
    key: group.project.id,
    group,
  }));
  if (groups.chats.length || home)
    items.push({ kind: "chats", key: "chats", threads: groups.chats });
  if (accounts) items.push({ kind: "accounts", key: "accounts" });
  if (groups.archived.length)
    items.push({ kind: "archived", key: "archived", groups: groups.archived });
  if (!items.length) items.push({ kind: "empty", key: "empty" });
  return items;
}

const holds = (rows: readonly ThreadRow[], id: string): boolean =>
  rows.some((r) => r.id === id || (r.children ? holds(r.children, id) : false));

/** The card or section a session's row lives in, or -1. */
export function sessionItemIndex(items: readonly SidebarItem[], id: string): number {
  return items.findIndex((item) => {
    switch (item.kind) {
      case "project":
        return holds(item.group.threads, id);
      case "chats":
        return holds(item.threads, id);
      case "archived":
        return item.groups.some((g) => holds(g.threads, id));
      case "accounts":
      case "empty":
        return false;
    }
  });
}

export type Windowed<T> = {
  /** The rows to mount; the input array itself when it all fits. */
  shown: readonly T[];
  /** Rows behind the "show more" row. */
  hidden: number;
};

/** A page of `rows`, grown by `requested`, always reaching the active row. */
export function windowRows<T extends { id: string }>(
  rows: readonly T[],
  requested: number,
  activeId: string | null | undefined,
): Windowed<T> {
  const activeIndex = activeId ? rows.findIndex((r) => r.id === activeId) : -1;
  const count = sessionListWindow(rows.length, requested, activeIndex);
  return {
    shown: count === rows.length ? rows : rows.slice(0, count),
    hidden: rows.length - count,
  };
}

export const nextPage = (requested: number): number =>
  requested + SESSION_LIST_PAGE;

export type LiveLine<T extends CardThread> = {
  kind: "running" | "paused" | "unread";
  /** The thread's id, so the window can find the active line. */
  id: string;
  thread: T;
};

/** The lines a card prints under its header: running, then paused, then unread. */
export function liveLines<T extends CardThread>(
  status: ProjectCardStatus<T>,
): LiveLine<T>[] {
  const lines: LiveLine<T>[] = [];
  for (const thread of status.running)
    lines.push({ kind: "running", id: thread.id, thread });
  for (const thread of status.paused)
    lines.push({ kind: "paused", id: thread.id, thread });
  for (const thread of status.unread)
    lines.push({ kind: "unread", id: thread.id, thread });
  return lines;
}
