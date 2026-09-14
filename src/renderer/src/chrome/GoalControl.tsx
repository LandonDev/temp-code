import { useEffect, useRef, useState } from "react";
import type { ThreadGoal } from "../lib/session";
import { client } from "../lib/tcserver/client";
import { goalEnterSubmits, goalStateOf, goalTriggerLabel } from "../lib/goalControl";
import { Popover } from "./Popover";
import { Target } from "./icons";

const WIDTH = 288;

/**
 * The composer's goal: a condition the harness keeps working toward,
 * checked after each turn. One button in the bottom bar, tinted while a
 * goal runs, opens a small editor to set, update or clear it. The tint
 * follows the folded goal only — the harness confirms with a goal event,
 * never the click.
 */
export function GoalControl({
  sessionId,
  goal,
  onClose,
}: {
  sessionId: string;
  goal?: ThreadGoal | null;
  onClose?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const state = goalStateOf(goal, draft, busy);

  useEffect(() => {
    if (open) setDraft(goal?.condition ?? "");
  }, [open, goal?.condition]);

  const dismiss = (refocus: boolean) => {
    setOpen(false);
    if (refocus) onClose?.();
  };
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      dismiss(true);
    } catch {
      /* the thread's error row reports it */
    } finally {
      setBusy(false);
    }
  };
  // Until M4's `setGoal`/`clearGoal` wrappers land in commands.ts, the
  // server methods are called with the same shape they will use.
  const submit = () =>
    void run(() => client.request("session.setGoal", { sessionId, condition: state.condition }));
  const clear = () => void run(() => client.request("session.clearGoal", { sessionId }));

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={goalTriggerLabel(goal)}
        aria-label={goalTriggerLabel(goal)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-goal-control
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? dismiss(true) : setOpen(true))}
        className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
          state.active
            ? "bg-accent/20 text-accent hover:bg-accent/30"
            : open
              ? "bg-content/10 text-content"
              : "bg-content/10 text-content/50 hover:bg-content/15 hover:text-content"
        }`}
      >
        <Target className="size-3.5" strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="top"
          width={WIDTH}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="dialog"
          aria-label="Goal"
          data-goal-control
          className="flex flex-col gap-2 p-2"
        >
          <textarea
            autoFocus
            rows={3}
            value={draft}
            placeholder="Keep working until…"
            className="w-full resize-none rounded-md border border-content/12 bg-transparent px-2 py-1.5 text-[13px] leading-5 text-content outline-none placeholder:text-content/40 focus:border-content/30"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (goalEnterSubmits(state, e.key, e.shiftKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={state.primaryDisabled}
              className="rounded-md bg-content px-2.5 py-0.5 text-[11px] text-background-base hover:bg-content/70 disabled:opacity-40"
              onClick={submit}
            >
              {busy ? "Setting…" : state.primary}
            </button>
            {state.active ? (
              <button
                type="button"
                disabled={!state.canClear}
                className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20 disabled:opacity-40"
                onClick={clear}
              >
                Clear
              </button>
            ) : null}
            {state.checked ? (
              <span className="ml-auto text-[11px] tabular-nums text-content/40">{state.checked}</span>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
