import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { goalEnterSubmits, goalStateOf } from "../lib/goalControl";
import type { ThreadGoal } from "../lib/session";
import { clearGoal, setGoal } from "../lib/tcserver/commands";
import { useSession, useSessionMeta } from "../lib/tcserver/store";

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

/**
 * The thread's goal: a condition the harness keeps working toward, checked
 * after each turn. Set, update or clear it here. What it shows follows the
 * folded goal only: the harness confirms with a goal event, never the click.
 */
export function GoalDialog({
  sessionId,
  goal,
  onClose,
}: {
  sessionId: string;
  goal?: ThreadGoal | null;
  onClose?: () => void;
}) {
  const open = useGoalDialog(sessionId);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const state = goalStateOf(goal, draft, busy);

  useEffect(() => {
    if (open) setDraft(goal?.condition ?? "");
  }, [open, goal?.condition]);

  const close = () => {
    goalDialog.close();
    onClose?.();
  };
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      close();
    } catch {
      /* the thread's error row reports it */
    } finally {
      setBusy(false);
    }
  };
  const submit = () => void run(() => setGoal(sessionId, state.condition));
  const clear = () => void run(() => clearGoal(sessionId));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? goalDialog.open(sessionId) : close())}>
      <DialogContent size="sm" finalFocus={onClose ? false : undefined}>
        <DialogTitle>Goal</DialogTitle>
        <div className="flex flex-col gap-1.5">
          <Textarea
            autoFocus
            rows={3}
            aria-label="Goal"
            value={draft}
            placeholder="Keep working until…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (goalEnterSubmits(state, e.key, e.shiftKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {state.checked ? <p className="text-xs tabular-nums text-muted-foreground">{state.checked}</p> : null}
        </div>
        <DialogFooter>
          {state.active ? (
            <Button variant="ghost" className="me-auto" disabled={!state.canClear} onClick={clear}>
              Clear
            </Button>
          ) : null}
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button disabled={state.primaryDisabled} onClick={submit}>
            {state.primary}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
