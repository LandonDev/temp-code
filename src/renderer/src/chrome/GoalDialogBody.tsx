import { useEffect, useState } from "react";
import { BusyLabel, Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { goalEnterSubmits, goalStateOf } from "../lib/goalControl";
import type { ThreadGoal } from "../lib/session";
import { clearGoal, setGoal } from "../lib/tcserver/commands";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { goalDialog, useGoalDialog } from "./GoalDialog";
import { ModalBody, ModalPanel } from "./Modal";

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
  // Which verb runs: the one clicked spins, the others wait.
  const [running, setRunning] = useState<"save" | "clear" | null>(null);
  const busy = running !== null;
  const state = goalStateOf(goal, draft, busy);

  useEffect(() => {
    if (open) setDraft(goal?.condition ?? "");
  }, [open, goal?.condition]);

  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const close = () => {
    goalDialog.close();
    onClose?.();
  };
  const run = async (verb: "save" | "clear", task: () => Promise<unknown>) => {
    setRunning(verb);
    setError(null);
    try {
      await task();
      close();
    } catch (err) {
      // A refused RPC writes no row on the thread: say it here.
      setError(errorText(err));
    } finally {
      setRunning(null);
    }
  };
  const submit = () => void run("save", () => setGoal(sessionId, state.condition));
  const clear = () => void run("clear", () => clearGoal(sessionId));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? goalDialog.open(sessionId) : busy ? undefined : close())}>
      <ModalPanel title="Goal" size="sm" busy={busy} finalFocus={onClose ? false : undefined}>
        <ModalBody>
          <div className="flex flex-col gap-1">
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
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter
          start={
            state.active ? (
              <Button variant="ghost" disabled={!state.canClear} onClick={clear}>
                <BusyLabel busy={running === "clear"} label="Clear" />
              </Button>
            ) : null
          }
          onCancel={close}
          confirmLabel={state.primary}
          pending={running === "save"}
          busy={running === "clear"}
          disabled={state.primaryDisabled}
          onConfirm={submit}
        />
      </ModalPanel>
    </Dialog>
  );
}
