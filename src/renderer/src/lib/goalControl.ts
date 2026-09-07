import type { ThreadGoal } from "./session";

/**
 * The composer's goal control: one button, plain with no goal and tinted
 * while one runs, opening a small editor that sets, updates or clears the
 * condition. The tint follows the folded goal only — the harness confirms
 * with a goal event, never the click.
 */

export type GoalState = {
  active: boolean;
  /** The trimmed draft. */
  condition: string;
  /** The draft differs from the running goal. */
  changed: boolean;
  /** The primary button: Set for a new goal, Update for a changed one. */
  primary: "Set" | "Update";
  primaryDisabled: boolean;
  /** Clear shows only while a goal runs. */
  canClear: boolean;
  /** "Checked 3×", once the harness has evaluated it. */
  checked: string | null;
};

export function goalStateOf(
  goal: ThreadGoal | null | undefined,
  draft: string,
  busy = false,
): GoalState {
  const active = !!goal;
  const condition = draft.trim();
  const changed = condition !== (goal?.condition ?? "");
  return {
    active,
    condition,
    changed,
    primary: active ? "Update" : "Set",
    primaryDisabled: !condition || !changed || busy,
    canClear: active && !busy,
    checked: goal && goal.iterations > 0 ? `Checked ${goal.iterations}×` : null,
  };
}

export function goalTriggerLabel(goal: ThreadGoal | null | undefined): string {
  return goal ? `Goal: ${goal.condition}` : "Set a goal";
}

/** Enter (without Shift) submits a changed, non-empty draft. */
export function goalEnterSubmits(
  state: GoalState,
  key: string,
  shiftKey: boolean,
): boolean {
  return key === "Enter" && !shiftKey && !state.primaryDisabled;
}
