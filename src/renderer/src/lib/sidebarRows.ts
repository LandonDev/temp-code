import type { SessionMeta } from "./tcserver/types";
import { threadStateOf, type ThreadState } from "../components/ui/status";
import type { CardThread } from "./projectCardModel";
import { type Catalog, workspacePathOfSession } from "./projectContext";
import { agentSummary, type AgentSummary } from "./threads/agents";
import { marksAtRest } from "./threadStripModel";
import { SESSION_LIST_PAGE, sessionListWindow } from "./sessionListWindow";
import {
  housedIds,
  threadRow,
  type ProjectGroup,
  type ThreadRow,
  type WorkspaceSessionGroups,
} from "./workspaceSessions";

/**
 * The sidebar's shape as data: the list the virtualizer walks, one entry
 * per project card plus the trailing sections, and the window a card or a
 * fold shows of its rows. Pure; the component owns the "show more" counts.
 */

export type SidebarItem =
  | { kind: "project"; key: string; group: ProjectGroup }
  | { kind: "chats"; key: "chats"; threads: ThreadRow[] }
  | { kind: "archived"; key: "archived"; groups: ProjectGroup[] }
  | { kind: "empty"; key: "empty" };

/** Cards first, then chats and archived when there are any, else the empty
 *  hint. The home has no projects, so it never shows the hint: an empty home
 *  is the column's header over nothing. */
export function sidebarItems(
  groups: WorkspaceSessionGroups,
  home = false,
): SidebarItem[] {
  const items: SidebarItem[] = groups.projects.map((group) => ({
    kind: "project",
    key: group.project.id,
    group,
  }));
  if (groups.chats.length)
    items.push({ kind: "chats", key: "chats", threads: groups.chats });
  if (groups.archived.length)
    items.push({ kind: "archived", key: "archived", groups: groups.archived });
  if (!items.length && !home) items.push({ kind: "empty", key: "empty" });
  return items;
}

const holds = (rows: readonly ThreadRow[], id: string): boolean =>
  rows.some(
    (r) =>
      r.id === id ||
      (r.children ? holds(r.children, id) : false) ||
      (r.batch ? holds(r.batch, id) : false),
  );

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

/** What a row's state reads: its own status and its tree's flags. */
export type RowStateInput = Pick<CardThread, "status"> &
  Partial<Pick<CardThread, "treeHasPaused" | "treeHasLiveWork" | "treeCanContinue">>;

/**
 * A row's state in the one vocabulary (components/ui/status.tsx): the tree's
 * flags folded into a wire status, then `threadStateOf`. A paused tree reads
 * paused; waiting reads waiting unless the tree needs recovery; a failure the
 * tree has not moved past reads failed; live work under a settled root reads
 * working. The glyph, word and tone come from `StatusMark` alone, and a row
 * draws a mark only where `marksAtRest` says so.
 */
export function rowState(t: RowStateInput): ThreadState {
  if (t.status === "paused" || t.treeHasPaused) return "paused";
  if (t.status === "waiting" && !t.treeCanContinue) return "waiting";
  if (!t.treeHasLiveWork && (t.status === "error" || t.treeCanContinue)) return "failed";
  if (t.treeHasLiveWork && (t.status === "idle" || t.status === "done" || t.status == null)) return "working";
  return threadStateOf(t.status);
}

/** The states a group's word says, loudest first; watching counts as working. */
export type GroupState = "waiting" | "failed" | "working" | "paused";

const GROUP_ORDER: readonly GroupState[] = ["waiting", "failed", "working", "paused"];

const groupStateOf = (state: ThreadState): GroupState | null =>
  state === "watching" ? "working" : (GROUP_ORDER as readonly ThreadState[]).includes(state) ? (state as GroupState) : null;

/** The row a group's word names: a batch thread is named by its master. */
type GroupRow = RowStateInput & {
  id: string;
  updatedAt: number;
  masterId?: string;
  housed?: boolean;
  batch?: readonly GroupRow[];
};

/** A project's or workspace's one word: its loudest state, the newest thread
 *  behind it (`about`), the others in that state newest first, and how many. */
export type GroupMark<T> = { state: GroupState; about: T; others: T[]; more: number };

/**
 * The loudest of waiting > failed > working > paused over every root and
 * every batch thread (`cardThreads`), or null when the group is quiet.
 * `about` is the newest root in that state, a batch thread's master standing
 * in for it; `more` counts the other roots in that state.
 */
export function groupMark<T extends GroupRow>(roots: readonly T[]): GroupMark<T> | null {
  const byId = new Map<string, T>(roots.map((r) => [r.id, r]));
  // Per state, each stand-in root with the newest update behind it.
  const found = new Map<GroupState, Map<T, number>>();
  const note = (row: GroupRow, standIn: T) => {
    const state = groupStateOf(rowState(row));
    if (!state) return;
    const seen = found.get(state) ?? found.set(state, new Map()).get(state)!;
    seen.set(standIn, Math.max(seen.get(standIn) ?? 0, row.updatedAt));
  };
  for (const root of roots) {
    // Only a thread housed under a pinned master is named by it; once the
    // master is unpinned its former batch threads are roots of their own.
    const standIn = (root.housed && root.masterId && byId.get(root.masterId)) || root;
    note(root, standIn);
    for (const b of root.batch ?? []) note(b, root);
  }
  for (const state of GROUP_ORDER) {
    const seen = found.get(state);
    if (!seen?.size) continue;
    const [about, ...others] = [...seen].sort((a, b) => b[1] - a[1]).map(([row]) => row);
    return { state, about, others, more: others.length };
  }
  return null;
}

/** Is any root unread: settled, unseen, quiet, and not inside a master. */
export function groupUnread(roots: readonly (RowStateInput & { unread?: boolean; housed?: boolean })[]): boolean {
  return roots.some((r) => !!r.unread && !r.housed && !marksAtRest(rowState(r)));
}

/** A rail row's state: its word with the thread behind it, and whether it reads unread. */
export type WorkspaceMark = { mark: GroupMark<ThreadRow> | null; unread: boolean };

/**
 * One mark per workspace path: the roots of every unarchived project (and the
 * loose chats) folded into `groupMark` and `groupUnread`. A thread inside a
 * master (`housedIds`) still lights the word, never the unread weight.
 * `keyOf` folds a workspace's copies on other hosts into its leader's path
 * (lib/linkedRail.ts `aliasKeys`), so a linked row reads every copy as one.
 */
export function workspaceMarks(
  metas: readonly SessionMeta[],
  catalog: Catalog,
  lastSeen: Record<string, number>,
  floor = 0,
  keyOf: (path: string) => string = (path) => path,
): Map<string, WorkspaceMark> {
  const archivedProjects = new Set(catalog.projects.filter((p) => p.archived).map((p) => p.id));
  const housed = housedIds(metas);
  const byPath = new Map<string, ThreadRow[]>();
  for (const meta of metas) {
    if (meta.parentId || meta.archived) continue;
    // An archived project's threads never enter the workspace's list, so
    // they say nothing on its row either.
    if (meta.projectId && archivedProjects.has(meta.projectId)) continue;
    const at = workspacePathOfSession(meta, catalog);
    if (!at) continue;
    const path = keyOf(at);
    const row = threadRow(meta, lastSeen, floor, housed.has(meta.id));
    const list = byPath.get(path);
    if (list) list.push(row);
    else byPath.set(path, [row]);
  }
  const out = new Map<string, WorkspaceMark>();
  for (const [path, rows] of byPath) {
    const mark = groupMark(rows);
    const unread = groupUnread(rows);
    if (mark || unread) out.set(path, { mark, unread });
  }
  return out;
}

/** A row's subagents in the fleet's words, only while one of them works,
 *  waits or failed: a tree of finished agents has nothing to say. */
export function liveAgents(rows: readonly ThreadRow[] | undefined): AgentSummary | null {
  if (!rows?.length) return null;
  const all: ThreadRow[] = [];
  const walk = (list: readonly ThreadRow[]) => {
    for (const r of list) {
      all.push(r);
      if (r.children) walk(r.children);
    }
  };
  walk(rows);
  const s = agentSummary(all);
  return s && s.working + s.waiting + s.failed > 0 ? s : null;
}

export type BatchLine = { thread: ThreadRow; state: ThreadState; agents: AgentSummary | null };

/** A master on its card: its own line, its own working subagents apart,
 *  then every batch thread with something to say, loudest first. Queued
 *  and settled ones fold into counts. */
export type MasterBlock = {
  master: ThreadRow;
  state: ThreadState;
  unread: boolean;
  agents: AgentSummary | null;
  lines: BatchLine[];
  queued: number;
  done: number;
  total: number;
};

const LINE_RANK: Record<ThreadState, number> = {
  waiting: 0,
  failed: 1,
  paused: 2,
  working: 3,
  watching: 3,
  "plan-ready": 4,
  stopped: 5,
  queued: 6,
  done: 7,
  idle: 7,
};

/** The block for a master row with a batch, or null when nothing in it
 *  says anything: a master settled and seen over a finished batch is a
 *  dormant thread like any other. */
export function masterBlock(master: ThreadRow, unread: boolean): MasterBlock | null {
  const batch = master.batch;
  if (!batch?.length) return null;
  const lines: BatchLine[] = [];
  let queued = 0;
  let done = 0;
  for (const thread of batch) {
    const state = rowState(thread);
    if (state === "queued") queued++;
    else if (!marksAtRest(state)) done++;
    else lines.push({ thread, state, agents: liveAgents(thread.children) });
  }
  lines.sort((a, b) => LINE_RANK[a.state] - LINE_RANK[b.state]);
  const state = rowState(master);
  const agents = liveAgents(master.children);
  if (!lines.length && !queued && !unread && !agents && !marksAtRest(state)) return null;
  return { master, state, unread, agents, lines, queued, done, total: batch.length };
}

/** The blocks of a card's roots, one per master with something to say. */
export function masterBlocks(
  roots: readonly ThreadRow[],
  isUnread: (id: string) => boolean,
): MasterBlock[] {
  const out: MasterBlock[] = [];
  for (const root of roots) {
    const block = masterBlock(root, isUnread(root.id));
    if (block) out.push(block);
  }
  return out;
}
