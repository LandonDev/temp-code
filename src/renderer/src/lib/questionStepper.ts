import type { QuestionSpec } from "./session";

/**
 * One question at a time. The harness may batch several questions into one
 * request; the card walks them in order, keeps every pick so Back loses
 * nothing, and submits the whole set once the last one is answered. A
 * single-select pick answers its question on the spot; multi-select and
 * typed answers wait for Next.
 */

export type StepperState = {
  step: number;
  picked: string[][];
  other: string[];
};

export function initialStepper(count: number): StepperState {
  return {
    step: 0,
    picked: Array.from({ length: count }, () => []),
    other: Array.from({ length: count }, () => ""),
  };
}

export function toggleOption(
  state: StepperState,
  i: number,
  label: string,
  multi: boolean,
): StepperState {
  const picked = state.picked.slice();
  const has = picked[i].includes(label);
  picked[i] = multi
    ? has
      ? picked[i].filter((l) => l !== label)
      : [...picked[i], label]
    : has
      ? []
      : [label];
  return { ...state, picked };
}

export function typeOther(state: StepperState, i: number, text: string): StepperState {
  const other = state.other.slice();
  other[i] = text;
  return { ...state, other };
}

/** The picks plus the typed answer, for one question. */
export function stepAnswers(state: StepperState, i: number): string[] {
  const typed = state.other[i]?.trim() ?? "";
  const picked = state.picked[i] ?? [];
  return typed ? [...picked, typed] : picked;
}

export function answersOf(state: StepperState): string[][] {
  return state.picked.map((_, i) => stepAnswers(state, i));
}

export function stepComplete(state: StepperState, i: number): boolean {
  return stepAnswers(state, i).length > 0;
}

export function isLastStep(state: StepperState, count: number): boolean {
  return state.step >= count - 1;
}

export function next(state: StepperState, count: number): StepperState {
  return isLastStep(state, count) ? state : { ...state, step: state.step + 1 };
}

export function back(state: StepperState): StepperState {
  return state.step === 0 ? state : { ...state, step: state.step - 1 };
}

/** "2 of 3" — or nothing for a lone question. */
export function stepLabel(step: number, count: number): string | null {
  return count > 1 ? `${step + 1} of ${count}` : null;
}

/** What the primary button says on this step. */
export function advanceLabel(state: StepperState, count: number): "Next" | "Answer" {
  return isLastStep(state, count) ? "Answer" : "Next";
}

/**
 * A pick on a single-select question answers it: the next question opens,
 * or the set resolves when this was the last. Returns the new state and
 * whether the set is now complete.
 */
export function pickAndAdvance(
  state: StepperState,
  questions: QuestionSpec[],
  label: string,
): { state: StepperState; done: boolean } {
  const i = state.step;
  const multi = questions[i]?.multiSelect === true;
  let nextState = toggleOption(state, i, label, multi);
  if (multi) return { state: nextState, done: false };
  if (!stepComplete(nextState, i)) return { state: nextState, done: false };
  if (isLastStep(nextState, questions.length)) return { state: nextState, done: true };
  nextState = next(nextState, questions.length);
  return { state: nextState, done: false };
}

/** Next on a complete step; resolves on the last one. */
export function advance(
  state: StepperState,
  count: number,
): { state: StepperState; done: boolean } {
  if (!stepComplete(state, state.step)) return { state, done: false };
  if (isLastStep(state, count)) return { state, done: true };
  return { state: next(state, count), done: false };
}
