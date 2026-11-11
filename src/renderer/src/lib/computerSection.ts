import { useMemo } from "react";
import { treeIds } from "./activity";
import { hasHistory, historyKeys, useComputerHistory, type HistoryKey, type KeyHistory } from "./computerHistory";
import { previewContext, useComputerEntries, type ComputerEntry } from "./computerSessions";
import { useSessionMeta, useSessionMetas } from "./tcserver/store";

/**
 * What the right panel's Computer section reads for a thread (docs/LAYOUT.md
 * "The right side"): the live sessions of its tree that this desktop can
 * draw, and the journal this Mac keeps for each thread of the tree. The
 * section exists with either; a thread that never used the computer has
 * neither, so no section and no cue. Off a Mac's desktop (the browser, a
 * Linux desktop, a box thread driving another Mac) nothing is drawable and
 * the session's row stays in Activity.
 */
export interface ComputerSectionData {
  /** the live sessions this desktop can draw, the one that acted last first */
  entries: ComputerEntry[];
  keys: HistoryKey[];
  histories: Record<string, KeyHistory>;
  /** a drawable live session, or kept steps */
  exists: boolean;
  live: boolean;
}

/** The drawable entries, the one that acted last first: its window is the one the section follows. */
export function drawable(entries: readonly ComputerEntry[]): ComputerEntry[] {
  return entries.filter((e) => e.previewable).sort((a, b) => b.row.lastCallAt - a.row.lastCallAt);
}

export function useComputerSection(threadId: string): ComputerSectionData {
  const meta = useSessionMeta(threadId);
  const metas = useSessionMetas();
  const host = meta?.environmentId;
  const tree = useMemo(() => treeIds(threadId, metas), [metas, threadId]);
  const all = useComputerEntries(tree, host);
  const entries = useMemo(() => drawable(all), [all]);
  const keys = useMemo(() => (host ? historyKeys(tree, host, previewContext()) : []), [host, tree]);
  const histories = useComputerHistory(keys);
  return useMemo(
    () => ({ entries, keys, histories, exists: entries.length > 0 || hasHistory(histories), live: entries.length > 0 }),
    [entries, histories, keys],
  );
}
