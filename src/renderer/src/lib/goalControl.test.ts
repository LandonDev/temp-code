import { describe, expect, it } from "vitest";
import { goalEnterSubmits, goalStateOf, goalTriggerLabel } from "./goalControl";

const goal = { condition: "tests pass", iterations: 2, setAt: 1 };

describe("goalStateOf", () => {
  it("offers Set for a new goal and holds it back on an empty draft", () => {
    expect(goalStateOf(null, "   ")).toMatchObject({ active: false, primary: "Set", primaryDisabled: true, canClear: false, checked: null });
    expect(goalStateOf(null, " ship it ")).toMatchObject({ condition: "ship it", changed: true, primaryDisabled: false });
  });

  it("offers Update and Clear while a goal runs, only when the draft changed", () => {
    expect(goalStateOf(goal, "tests pass")).toMatchObject({ active: true, primary: "Update", primaryDisabled: true, canClear: true, checked: "Checked 2×" });
    expect(goalStateOf(goal, "tests pass twice")).toMatchObject({ primaryDisabled: false });
  });

  it("locks both buttons while a request runs", () => {
    expect(goalStateOf(goal, "new", true)).toMatchObject({ primaryDisabled: true, canClear: false });
  });

  it("hides the count before the first check", () => {
    expect(goalStateOf({ ...goal, iterations: 0 }, "").checked).toBeNull();
  });
});

describe("goalTriggerLabel", () => {
  it("names the goal on the button", () => {
    expect(goalTriggerLabel(null)).toBe("Set a goal");
    expect(goalTriggerLabel(goal)).toBe("Goal: tests pass");
  });
});

describe("goalEnterSubmits", () => {
  it("submits on plain Enter with a valid draft", () => {
    expect(goalEnterSubmits(goalStateOf(null, "x"), "Enter", false)).toBe(true);
    expect(goalEnterSubmits(goalStateOf(null, "x"), "Enter", true)).toBe(false);
    expect(goalEnterSubmits(goalStateOf(null, ""), "Enter", false)).toBe(false);
  });
});
