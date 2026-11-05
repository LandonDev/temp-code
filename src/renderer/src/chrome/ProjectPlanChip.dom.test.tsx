// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";

let planState: ProjectPlanState | null | undefined = null;
vi.mock("../lib/projectPlan", () => ({ useProjectPlan: () => planState }));
vi.mock("../stores/project", () => ({ useProject: () => "p1" }));
vi.mock("../hooks/usePlanFile", () => ({ usePlanFile: () => null }));
vi.mock("../lib/tcserver/store", () => ({ sessionStore: { get: () => undefined, requestOpen: vi.fn() } }));
vi.mock("../surfaces/threads/ProjectPlanCard", () => ({ ProjectPlanOptions: () => null }));

import { MENU_ROW } from "../components/ui/menu-row";
import { TOOLTIP_DELAY, tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { ProjectPlanChip, planChipLabel } from "./ProjectPlanChip";

const base: ProjectPlanState = {
  projectId: "p1",
  path: "/repo/.temp-code/plans/project.md",
  exists: true,
  pinned: false,
  sessionId: "pp",
  complete: true,
  milestones: [
    { index: 1, title: "A", done: true },
    { index: 2, title: "B", done: true },
    { index: 3, title: "C", done: true },
    { index: 4, title: "D", done: false },
    { index: 5, title: "E", done: false },
    { index: 6, title: "F", done: false },
    { index: 7, title: "G", done: false },
  ],
  missing: [],
};

afterEach(cleanup);

describe("ProjectPlanChip", () => {
  it("is absent without a project plan", () => {
    planState = null;
    render(<ProjectPlanChip />);
    expect(screen.queryByText(/Plan/)).toBeNull();
    planState = undefined;
    render(<ProjectPlanChip />);
    expect(screen.queryByText(/Plan/)).toBeNull();
  });

  it("says Plan while the plan exists, and counts the milestones once it is the project's plan", () => {
    planState = base;
    const view = render(<ProjectPlanChip />);
    expect(screen.getByText("Plan")).toBeTruthy();
    view.unmount();
    planState = { ...base, pinned: true };
    render(<ProjectPlanChip />);
    const chip = screen.getByRole("button");
    expect(chip.textContent).toBe("Plan3/7");
    expect(chip.textContent).not.toMatch(/ · /);
    expect(chip.hasAttribute("title")).toBe(false);
  });

  it("labels Plan alone until the plan is kept", () => {
    expect(planChipLabel({ ...base, pinned: false })).toEqual({ label: "Plan", tally: null });
    expect(planChipLabel({ ...base, pinned: true })).toEqual({ label: "Plan", tally: "3/7" });
  });

  it("opens a popover whose first row opens the plan: a menu row with its glyph", async () => {
    planState = base;
    render(<ProjectPlanChip />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    const open = (await screen.findByText("Open the plan")).closest("button")!;
    for (const c of [...MENU_ROW.split(" "), "h-7"]) expect(open.className.split(/\s+/)).toContain(c);
    expect(open.className).not.toContain("h-8");
    expect(open.querySelector("svg")).toBeTruthy();
  });

  it("puts 8px between its glyph and word and 4px before the tally, the glyph in the word's ink, and no tooltip", async () => {
    await tooltipChunk.load();
    act(() => warmTooltips());
    planState = { ...base, pinned: true };
    render(<ProjectPlanChip />);
    const chip = screen.getByRole("button");
    expect(chip.className.split(/\s+/)).toContain("gap-2");
    const glyph = chip.querySelector("svg")!;
    expect(glyph.getAttribute("class")).not.toContain("text-muted-foreground");
    const words = screen.getByText("Plan").parentElement!;
    expect(words.className.split(/\s+/)).toContain("gap-1");
    expect(words.textContent).toBe("Plan3/7");
    // Its words say what it is: hovering it opens nothing.
    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    fireEvent.mouseEnter(chip);
    fireEvent.mouseMove(chip);
    await act(() => new Promise((r) => setTimeout(r, TOOLTIP_DELAY + 100)));
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });
});
