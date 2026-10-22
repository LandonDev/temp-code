import { useRef, useSyncExternalStore } from "react";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

/** Is this session a master thread (CLAUDE.md "Master threads")? The flag
 *  lives on the session row; a project may have any number of masters. */
export function isMasterThread(session: { isMaster?: boolean | null }): boolean {
  return !!session.isMaster;
}

/** The ids of every master the store knows, sorted so an unchanged set compares equal. */
export function masterIdsOf(metas: readonly Pick<SessionMeta, "id" | "isMaster">[]): string[] {
  return metas
    .filter((m) => m.isMaster)
    .map((m) => m.id)
    .sort();
}

/** The masters as a set, the same object while none was pinned or unpinned. */
export function useMasterIds(): ReadonlySet<string> {
  const cache = useRef<{ key: string; set: ReadonlySet<string> }>({ key: "", set: new Set() });
  return useSyncExternalStore(sessionStore.onMetaChange.bind(sessionStore), () => {
    const ids = masterIdsOf(sessionStore.metas());
    const key = ids.join("\n");
    if (key !== cache.current.key) cache.current = { key, set: new Set(ids) };
    return cache.current.set;
  });
}

/** The menu's word for the pin: a master may stop being one. */
export function masterMenuLabel(master: boolean): string {
  return master ? "Not a master" : "Make master thread";
}
