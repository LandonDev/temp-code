import { useMemo, useSyncExternalStore } from "react";
import { projectCardStatus, type CardThread } from "../lib/projectCardModel";
import type { Catalog } from "../lib/projectContext";
import { homeOrWorkspacePath, workspacePathOfSession } from "../lib/projectContext";
import type { Session } from "../lib/session";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { sessionStore, useSessionMetas } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";

export interface ProjectSignals {
  /** Folders with a turn in flight. */
  busy: string[];
  /** Folders holding a thread that is blocked on the user: waiting on an
   *  answer, errored, or recoverable. */
  needsYou: string[];
}

type SignalSession = Pick<
  Session,
  "cwd" | "projectId" | "workspaceId" | "busy" | "status" | "treeCanContinue"
>;

/** The same buckets `projectCardStatus()` calls waiting and failed, so the
 *  rail and the expanded card never disagree about a project. */
export function sessionNeedsYou(session: SignalSession): boolean {
  return session.status === "waiting" || session.status === "error" || !!session.treeCanContinue;
}

/**
 * Fold sessions into the two path sets the rail draws. A thread that needs
 * you is not also busy: the store counts "waiting" as an open status, and a
 * thread blocked on an answer is not working.
 */
export function projectSignals(
  sessions: readonly SignalSession[],
  catalog: Catalog,
): ProjectSignals {
  const busy = new Set<string>();
  const needsYou = new Set<string>();
  for (const session of sessions) {
    const needs = sessionNeedsYou(session);
    if (!needs && !session.busy) continue;
    const path = workspacePathOfSession(session, catalog);
    if (!path) continue;
    // A loose chat signals on the rail's Chats entry, keyed "~".
    (needs ? needsYou : busy).add(homeOrWorkspacePath(path));
  }
  // Needs-you outranks working, per folder as well as per thread.
  for (const path of needsYou) busy.delete(path);
  return { busy: [...busy].sort(), needsYou: [...needsYou].sort() };
}

/** Separators a folder name cannot contain — paths hold spaces and
 *  newlines, so neither can divide the key. */
const UNIT = "";
const GROUP = "";

/**
 * Workspace folders with a turn in flight, and those holding a thread that
 * needs you. The store is read through a flat string key, so a streamed turn
 * that moves neither set re-renders nothing.
 */
export function useProjectSignals(): ProjectSignals {
  const catalog = useWorkspaceCatalog();
  const key = useSyncExternalStore(sessionStore.subscribe, () => {
    const { busy, needsYou } = projectSignals(sessionStore.getSnapshot(), catalog);
    return busy.join(UNIT) + GROUP + needsYou.join(UNIT);
  });
  return useMemo(() => {
    const [busy, needsYou] = key.split(GROUP);
    return {
      busy: busy ? busy.split(UNIT) : [],
      needsYou: needsYou ? needsYou.split(UNIT) : [],
    };
  }, [key]);
}

// ── per-workspace rail status ────────────────────────────────────────

export type WorkspaceRailStatusKind = "paused" | "needsYou" | "busy" | "unread";

export type WorkspaceRailStatus = {
  kind: WorkspaceRailStatusKind | null;
  /** Threads in the dominant bucket, for the chip's title. */
  count: number;
  /** The busy bucket's own running threads. Only "busy" carries them: the
   *  rail shows these inline as a line under the workspace, no chip or
   *  popover needed to say what a workspace is doing. */
  running?: CardThread[];
};

const RAIL_STATUS_NONE: WorkspaceRailStatus = { kind: null, count: 0 };

/**
 * One dominant status per workspace path, loudest first: paused, needs you
 * (waiting on an answer or a recoverable failure), busy (a turn in flight
 * anywhere in the tree), unread (settled and unseen), else none. Built on
 * `projectCardStatus()` — the same fold the Sessions tab's project card and
 * the rail's own thread popover use — so the chip and what it opens never
 * disagree about a workspace's state.
 */
export function workspaceRailStatuses(
  metas: readonly SessionMeta[],
  catalog: Catalog,
  lastSeen: Record<string, number>,
  floor = 0,
): Map<string, WorkspaceRailStatus> {
  const archivedProjects = new Set(
    catalog.projects.filter((p) => p.archived).map((p) => p.id),
  );
  const byPath = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    if (meta.parentId || meta.archived) continue;
    // An archived project's threads never enter the workspace's own project
    // list (`groupWorkspaceSessions`); a stuck thread inside one is not
    // something the chip should surface, or the popover would disagree.
    if (meta.projectId && archivedProjects.has(meta.projectId)) continue;
    const path = workspacePathOfSession(meta, catalog);
    if (!path) continue;
    const list = byPath.get(path);
    if (list) list.push(meta);
    else byPath.set(path, [meta]);
  }
  const out = new Map<string, WorkspaceRailStatus>();
  for (const [path, threads] of byPath) {
    const status = projectCardStatus(threads, null, lastSeen, floor);
    const needsYouCount = status.waiting + status.failed;
    const dominant: WorkspaceRailStatus =
      status.paused.length > 0
        ? { kind: "paused", count: status.paused.length }
        : needsYouCount > 0
          ? { kind: "needsYou", count: needsYouCount }
          : status.running.length > 0
            ? { kind: "busy", count: status.running.length, running: status.running }
            : status.unread.length > 0
              ? { kind: "unread", count: status.unread.length }
              : RAIL_STATUS_NONE;
    if (dominant.kind) out.set(path, dominant);
  }
  return out;
}

/** The rail's per-workspace status map, recomputed only when the metas,
 *  catalog, or seen state actually change. */
export function useWorkspaceRailStatuses(): Map<string, WorkspaceRailStatus> {
  const catalog = useWorkspaceCatalog();
  const metas = useSessionMetas();
  const lastSeen = useLastSeen();
  const floor = useSeenFloor();
  return useMemo(
    () => workspaceRailStatuses(metas, catalog, lastSeen, floor),
    [metas, catalog, lastSeen, floor],
  );
}
