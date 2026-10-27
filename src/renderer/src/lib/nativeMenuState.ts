import { useEffect } from "react";
import { EMPTY_MENU_STATE, sameMenuState, type MenuState } from "@shared/menuTree";
import { shellStore } from "../stores/shell";
import { threadsToMarkRead } from "./markRead";
import { menuStateSender } from "./native";
import { rightPanel } from "./rightPanel";
import { loadLastSeen, seenFloor, subscribeLastSeen } from "./sessionSeen";
import { loadNotesEnabled, subscribeNotesEnabled } from "./settings";
import { sessionStore } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import type { BatchAction } from "./threadBatch";
import { batchCounts, type BatchCounts } from "./threadBatchMenu";
import { isUnread } from "./threadStripModel";

/**
 * What the native menu bar shows for this window (src/shared/menuTree.ts):
 * Show or Hide on the three toggles, and the rows that would do nothing
 * greyed. Sent to main over `menu:state` when it changes; a no-op at /ui.
 */

export type MenuFacts = {
  sidebarOpen: boolean;
  /** The focused root thread's panel, or `none` with no root thread on screen. */
  panel: "open" | "closed" | "none";
  dockOpen: boolean;
  /** The dock's cwd is a project: Show Terminal has somewhere to open. */
  dockUsable: boolean;
  notesEnabled: boolean;
  unread: number;
  counts: BatchCounts;
};

const FLEET_IDS: Record<BatchAction, string> = {
  pause: "pause_all_threads",
  resume: "resume_all_threads",
  stop: "stop_all_threads",
  archiveDone: "archive_done_threads",
};

export function menuStateOf(f: MenuFacts): MenuState {
  const open: string[] = [];
  const disabled: string[] = [];
  if (f.sidebarOpen) open.push("toggle_sidebar");
  if (f.panel === "open") open.push("toggle_panel");
  if (f.panel === "none") disabled.push("toggle_panel");
  if (f.dockOpen) open.push("toggle_terminal");
  if (!f.dockUsable) disabled.push("toggle_terminal");
  if (!f.notesEnabled) disabled.push("open_notes");
  if (f.unread === 0) disabled.push("mark_all_read");
  for (const action of Object.keys(FLEET_IDS) as BatchAction[]) {
    if (f.counts[action] === 0) disabled.push(FLEET_IDS[action]);
  }
  return { open, disabled };
}

const EVERYWHERE = { kind: "all" } as const;

/** The store-backed facts, read now. */
function readFacts(dock: { dockOpen: boolean; dockUsable: boolean }): MenuFacts {
  const metas = sessionStore.metas();
  const catalog = workspaceStore.getSnapshot();
  const lastSeen = loadLastSeen();
  const floor = seenFloor();
  // A subagent's view has no panel (ThreadView), so only a root thread can show one.
  const focusedId = rightPanel.focused();
  const focused = focusedId && !sessionStore.metaOf(focusedId)?.parentId ? focusedId : null;
  const markable = new Set(threadsToMarkRead(metas, catalog, null).ids);
  const unread = metas.filter((m) => markable.has(m.id) && isUnread(m, lastSeen, floor)).length;
  return {
    sidebarOpen: shellStore.getState().projectRailOpen,
    panel: focused ? (rightPanel.get(focused).open ? "open" : "closed") : "none",
    ...dock,
    notesEnabled: loadNotesEnabled(),
    unread,
    counts: batchCounts(metas, { catalog, lastSeen, floor, scope: EVERYWHERE, now: Date.now() }),
  };
}

/** Thread metas move many times a second while turns stream; the menu reads them at most this often. */
export const MENU_STATE_THROTTLE_MS = 250;

/** Archive Done's age rule moves with the clock alone; the facts are read again this often. */
export const MENU_STATE_CLOCK_MS = 30_000;

type Send = (state: MenuState) => void;

/** Follows every store the facts come from and sends a state only when it changed. */
export function publishMenuState(
  dock: () => { dockOpen: boolean; dockUsable: boolean },
  send: Send,
): { refresh: () => void; stop: () => void } {
  let last: MenuState = EMPTY_MENU_STATE;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const next = menuStateOf(readFacts(dock()));
    if (sent && sameMenuState(next, last)) return;
    last = next;
    sent = true;
    send(next);
  };
  const schedule = (): void => {
    if (timer === null) timer = setTimeout(flush, MENU_STATE_THROTTLE_MS);
  };
  const offs = [
    sessionStore.onMetaChange(schedule),
    workspaceStore.subscribe(schedule),
    subscribeLastSeen(schedule),
    subscribeNotesEnabled(schedule),
    rightPanel.subscribe(schedule),
    shellStore.subscribe(schedule),
  ];
  const clock = setInterval(schedule, MENU_STATE_CLOCK_MS);
  flush();
  return {
    refresh: schedule,
    stop: () => {
      clearInterval(clock);
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    },
  };
}

/** App.tsx mounts this once with the dock's facts; it renders nothing. */
export function useNativeMenuState(dock: { dockOpen: boolean; dockUsable: boolean }): void {
  const { dockOpen, dockUsable } = dock;
  useEffect(() => {
    const setState = menuStateSender();
    if (!setState) return;
    const publisher = publishMenuState(() => ({ dockOpen, dockUsable }), setState);
    return publisher.stop;
  }, [dockOpen, dockUsable]);
}
