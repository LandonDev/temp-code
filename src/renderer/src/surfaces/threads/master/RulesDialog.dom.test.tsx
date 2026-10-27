// @vitest-environment jsdom
/** The rules dialog keeps land first: its row has no Up, Down or Remove, and nothing moves above it. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RulesDialog } from "./RulesDialog";
import type { Rules } from "./useMasterModel";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const rules = (steps: Rules["steps"]): Rules => ({ land: "as-they-finish", then: "notify", steps }) as Rules;
const ids = () => [...document.querySelectorAll("[data-rule-step]")].map((row) => row.getAttribute("data-rule-step"));

describe("RulesDialog", () => {
  it("draws land first with no move or remove controls, and the next row cannot move above it", () => {
    render(
      <RulesDialog
        rules={rules([
          { id: "gate", name: "Gate", kind: "gate" },
          { id: "land", name: "Land", kind: "land" },
          { id: "release", name: "Release", kind: "release" },
        ])}
        onClose={() => {}}
        onSave={async () => {}}
      />,
    );
    expect(ids()).toEqual(["land", "gate", "release"]);
    const land = document.querySelector('[data-rule-step="land"]')!;
    expect(land.querySelectorAll("button")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Move Gate up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Release up" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove Land" })).toBeNull();
  });
});
