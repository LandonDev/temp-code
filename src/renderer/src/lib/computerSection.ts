import { useMemo } from "react";
import { useStore } from "zustand";
import { treeIds } from "./activity";
import { hasHistory, historyKeys, nowState, useComputerHistory, type HistoryKey, type KeyHistory } from "./computerHistory";
import { computerSessionsStore, previewContext, useComputerEntries, type ComputerEntry } from "./computerSessions";
import { useSessionMeta, useSessionMetas, useSessionMetasWhen } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

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

/** The ids of a thread's tree, the same set while the tree is the same: a push that moves no thread in or out changes nothing downstream. */
function useTree(threadId: string | null, metas: readonly SessionMeta[]): ReadonlySet<string> {
  const ids = threadId ? [...treeIds(threadId, metas)].join("\n") : "";
  return useMemo(() => new Set(ids ? ids.split("\n") : []), [ids]);
}

export function useComputerSection(threadId: string): ComputerSectionData {
  const meta = useSessionMeta(threadId);
  const metas = useSessionMetas();
  const host = meta?.environmentId;
  const tree = useTree(threadId, metas);
  const all = useComputerEntries(tree, host);
  const entries = useMemo(() => drawable(all), [all]);
  const keys = useMemo(() => (host ? historyKeys(tree, host, previewContext()) : []), [host, tree]);
  const histories = useComputerHistory(keys);
  return useMemo(
    // a read that failed keeps the section there, with its Retry: a failure is not an empty history
    () => ({ entries, keys, histories, exists: entries.length > 0 || hasHistory(histories) || Object.values(histories).some((h) => h.status === "failed"), live: entries.length > 0 }),
    [entries, histories, keys],
  );
}

/** What the title bar's computer cue says (chrome/ComputerCue.tsx). */
export interface ComputerCue {
  /** the loudest of the live sessions: a card waits, a step is held, or it works */
  state: "working" | "waiting" | "queued";
  /** the cue's words: "Using TextEdit", "Needs you", "Waiting for the Mac" */
  label: string;
  /** the plain form, for its tooltip and name: "Computer use: Clicking Save in TextEdit" */
  line: string;
}

const LOUDNESS = { waiting: 2, queued: 1, working: 0 } as const;

/**
 * The cue for the live sessions this desktop can draw; null with none. One
 * that waits on the person leads, then one held in line, then the one that
 * acted last. It reads the live rows alone, so it needs no panel mounted.
 */
export function computerCue(entries: readonly ComputerEntry[]): ComputerCue | null {
  const live = drawable(entries);
  if (!live.length) return null;
  const loud = (e: ComputerEntry): number => LOUDNESS[nowState(e.row) ?? "working"];
  const lead = live.reduce((best, e) => (loud(e) > loud(best) ? e : best));
  const state = nowState(lead.row) ?? "working";
  const app = lead.row.apps[0];
  const using = app ? `Using ${app.name}` : "Using the Mac";
  // what it does now in the host's words; between calls, the window it is in
  const doing = lead.row.asking?.line ?? lead.row.running?.words ?? (app ? (app.window ? `${app.window} in ${app.name}` : app.name) : "Starting");
  return { state, label: state === "waiting" ? "Needs you" : state === "queued" ? "Waiting for the Mac" : using, line: `Computer use: ${doing}` };
}

/** The cue for the thread a pane shows: its tree's live sessions, live. */
export function useComputerCue(threadId: string | null): ComputerCue | null {
  const meta = useSessionMeta(threadId ?? "");
  const host = threadId ? meta?.environmentId : undefined;
  // The cue sits in every thread's title bar: it hears the metas only while its host has a live computer session.
  const hostLive = useStore(computerSessionsStore, (s) => (host ? (s.byHost[host]?.length ?? 0) > 0 : false));
  const metas = useSessionMetasWhen(hostLive);
  const tree = useTree(threadId, metas);
  const entries = useComputerEntries(tree, host);
  return useMemo(() => computerCue(entries), [entries]);
}
