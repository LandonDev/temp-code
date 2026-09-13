import { useMemo, useSyncExternalStore } from "react";
import type { Catalog } from "../lib/projectContext";
import { workspacePathOfSession } from "../lib/projectContext";
import type { Session } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
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
    (needs ? needsYou : busy).add(path);
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
