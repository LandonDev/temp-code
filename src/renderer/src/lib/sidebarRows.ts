import type { CardThread, ProjectCardStatus } from "./projectCardModel";
import { agentSummary, type AgentSummary } from "./threads/agents";
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
  | { kind: "archived"; key: "archived"; groups: ProjectGroup[] }
  | { kind: "empty"; key: "empty" };

/** Cards first, then chats and archived when there are any, else the empty
 *  hint. The home has no cards to offer, so its chats section always shows. */
export function sidebarItems(
  groups: WorkspaceSessionGroups,
  home = false,
): SidebarItem[] {
  const items: SidebarItem[] = groups.projects.map((group) => ({
    kind: "project",
    key: group.project.id,
    group,
  }));
  if (groups.chats.length || home)
    items.push({ kind: "chats", key: "chats", threads: groups.chats });
  if (groups.archived.length)
    items.push({ kind: "archived", key: "archived", groups: groups.archived });
  if (!items.length) items.push({ kind: "empty", key: "empty" });
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

/** One thread's state on a card line, in the card's own buckets and order
 *  (projectCardModel `projectCardStatus`): paused, waiting, failed, then
 *  working (a watching master and live work under it count), stopped,
 *  queued, else settled. */
export type LineState = "paused" | "waiting" | "failed" | "running" | "stopped" | "queued" | "settled";

export function lineState(t: CardThread): LineState {
  if (t.status === "paused" || t.treeHasPaused) return "paused";
  if (t.status === "waiting" && !t.treeCanContinue) return "waiting";
  if (!t.treeHasLiveWork && (t.status === "error" || t.treeCanContinue)) return "failed";
  if (
    t.status === "running" ||
    t.status === "starting" ||
    t.status === "watching" ||
    t.treeHasLiveWork
  )
    return "running";
  if (t.status === "stopped") return "stopped";
  if (t.status === "queued") return "queued";
  return "settled";
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

export type BatchLine = { thread: ThreadRow; state: LineState; agents: AgentSummary | null };

/** A master on its card: its own line, its own working subagents apart,
 *  then every batch thread with something to say, loudest first. Queued
 *  and settled ones fold into counts. */
export type MasterBlock = {
  master: ThreadRow;
  state: LineState;
  unread: boolean;
  agents: AgentSummary | null;
  lines: BatchLine[];
  queued: number;
  done: number;
  total: number;
};

const LINE_RANK: Record<LineState, number> = {
  waiting: 0,
  failed: 1,
  paused: 2,
  running: 3,
  stopped: 4,
  queued: 5,
  settled: 6,
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
    const state = lineState(thread);
    if (state === "queued") queued++;
    else if (state === "settled") done++;
    else lines.push({ thread, state, agents: liveAgents(thread.children) });
  }
  lines.sort((a, b) => LINE_RANK[a.state] - LINE_RANK[b.state]);
  const state = lineState(master);
  const agents = liveAgents(master.children);
  if (!lines.length && !queued && !unread && !agents && state === "settled") return null;
  return { master, state, unread, agents, lines, queued, done, total: batch.length };
}

/** The blocks of a card's roots, one per master with something to say. */
export function masterBlocks(
  roots: readonly ThreadRow[],
  status: Pick<ProjectCardStatus<CardThread>, "unread">,
): MasterBlock[] {
  const out: MasterBlock[] = [];
  for (const root of roots) {
    const block = masterBlock(root, status.unread.some((u) => u.id === root.id));
    if (block) out.push(block);
  }
  return out;
}

export type LiveLine<T extends CardThread> =
  | {
      kind: "running" | "paused" | "unread";
      /** The thread's id, so the window can find the active line. */
      id: string;
      thread: T;
    }
  | { kind: "master"; id: string; block: MasterBlock };

/** The lines a card prints under its header: each master with its batch
 *  first, then running, paused, unread. A thread inside a master
 *  (`housed`) prints only in its master's block. */
export function liveLines<T extends CardThread>(
  status: ProjectCardStatus<T>,
  roots: readonly ThreadRow[] = [],
): LiveLine<T>[] {
  const blocks = masterBlocks(roots, status);
  const inBlock = new Set(blocks.map((b) => b.master.id));
  const own = (t: T) => !t.housed && !inBlock.has(t.id);
  const lines: LiveLine<T>[] = blocks.map((block) => ({ kind: "master", id: block.master.id, block }));
  for (const thread of status.running)
    if (own(thread)) lines.push({ kind: "running", id: thread.id, thread });
  for (const thread of status.paused)
    if (own(thread)) lines.push({ kind: "paused", id: thread.id, thread });
  for (const thread of status.unread)
    if (own(thread)) lines.push({ kind: "unread", id: thread.id, thread });
  return lines;
}
