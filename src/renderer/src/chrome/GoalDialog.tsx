import { useState, useSyncExternalStore } from "react";
import { useSession, useSessionMeta } from "../lib/tcserver/store";
import { dialogsChunk } from "../surfaces/chunks";

/** The dialog's body rides the dialogs chunk (chrome/GoalDialogBody.tsx). */
const GoalDialog = dialogsChunk.surface("GoalDialog");

/** Which thread's goal dialog is open: the thread menu's "Goal…" sets it,
 *  on any surface, and the one GoalDialogHost answers. */
let openFor: string | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const goalDialog = {
  open(sessionId: string): void {
    openFor = sessionId;
    emit();
  },
  close(): void {
    openFor = null;
    emit();
  },
};

/** True while this thread's goal dialog is open. */
export function useGoalDialog(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => openFor === sessionId);
}

/**
 * The app's one goal dialog, mounted once (App.tsx): it answers Goal… for
 * any thread, on screen or not. The goal is the loaded session's, else its
 * meta's; closing gives focus back to what opened the dialog.
 */
export function GoalDialogHost() {
  const open = useSyncExternalStore(subscribe, () => openFor);
  // The last thread stays mounted, so the dialog plays its exit.
  const [sessionId, setSessionId] = useState(open);
  if (open && open !== sessionId) setSessionId(open);
  const session = useSession(sessionId);
  const meta = useSessionMeta(sessionId);
  if (!sessionId) return null;
  return <GoalDialog sessionId={sessionId} goal={session?.goal ?? meta?.goal ?? null} />;
}
