import { describe, expect, it } from "vitest";
import type { QuestionSpec } from "./session";
import {
  advance,
  advanceLabel,
  answersOf,
  back,
  initialStepper,
  pickAndAdvance,
  stepComplete,
  stepLabel,
  toggleOption,
  typeOther,
} from "./questionStepper";

const q = (question: string, multiSelect = false): QuestionSpec => ({
  question,
  options: [{ label: "A" }, { label: "B" }],
  multiSelect,
});

describe("question stepper", () => {
  it("walks a batch one question at a time", () => {
    const qs = [q("one"), q("two"), q("three")];
    let s = initialStepper(3);
    expect(stepLabel(s.step, 3)).toBe("1 of 3");
    expect(advanceLabel(s, 3)).toBe("Next");
    let r = pickAndAdvance(s, qs, "A");
    s = r.state;
    expect(r.done).toBe(false);
    expect(s.step).toBe(1);
    r = pickAndAdvance(s, qs, "B");
    s = r.state;
    expect(s.step).toBe(2);
    expect(advanceLabel(s, 3)).toBe("Answer");
    r = pickAndAdvance(s, qs, "A");
    expect(r.done).toBe(true);
    expect(answersOf(r.state)).toEqual([["A"], ["B"], ["A"]]);
  });

  it("keeps multi-select picks until Next", () => {
    const qs = [q("pick many", true), q("two")];
    let s = initialStepper(2);
    let r = pickAndAdvance(s, qs, "A");
    expect(r.done).toBe(false);
    expect(r.state.step).toBe(0);
    r = pickAndAdvance(r.state, qs, "B");
    expect(r.state.picked[0]).toEqual(["A", "B"]);
    s = advance(r.state, 2).state;
    expect(s.step).toBe(1);
  });

  it("does not advance an empty step", () => {
    const s = initialStepper(2);
    expect(stepComplete(s, 0)).toBe(false);
    expect(advance(s, 2)).toEqual({ state: s, done: false });
  });

  it("counts a typed answer and appends it to the picks", () => {
    let s = typeOther(initialStepper(1), 0, "  custom ");
    expect(stepComplete(s, 0)).toBe(true);
    s = toggleOption(s, 0, "A", false);
    expect(answersOf(s)).toEqual([["A", "custom"]]);
    expect(advance(s, 1).done).toBe(true);
  });

  it("goes back without losing picks and toggles a single pick off", () => {
    const qs = [q("one"), q("two")];
    let s = pickAndAdvance(initialStepper(2), qs, "A").state;
    s = back(s);
    expect(s.step).toBe(0);
    expect(s.picked[0]).toEqual(["A"]);
    s = toggleOption(s, 0, "A", false);
    expect(s.picked[0]).toEqual([]);
    expect(back(s)).toBe(s);
  });

  it("has no counter for a lone question", () => {
    expect(stepLabel(0, 1)).toBeNull();
  });
});
