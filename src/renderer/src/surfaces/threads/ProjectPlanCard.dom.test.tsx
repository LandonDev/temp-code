// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPlanState } from "@server/shared/contract-projectplan";
import type { Session } from "../../lib/session";

const actions = vi.hoisted(() => ({
  startMilestonePlanning: vi.fn(async () => ({ id: "plan-m2" })),
  startMilestoneOrchestration: vi.fn(async () => ({ id: "orch-m2" })),
  reviseProjectPlan: vi.fn(async () => {}),
  pinProjectPlan: vi.fn(async () => {}),
  tickMilestone: vi.fn(async () => {}),
}));
vi.mock("../../lib/projectPlan", () => actions);

import { MilestoneList, ProjectPlanCard, ProjectPlanOptions } from "./ProjectPlanCard";

const DOC = `---
status: complete
---
# Acme — project plan

## Milestones

### [x] 1. Data model
- Scope: tables
- Done when: schema test passes

### [ ] 2. API
- Scope: rest
- Dependencies: 1
- Done when: e2e passes

### [ ] 3. UI
`;

const session = {
  id: "pp",
  environmentId: "local",
  harness: "claude",
  model: "claude-haiku-5-5",
  modelSettings: { effort: "low" },
  runtimeMode: "ask",
  title: "Project plan",
  cwd: "/repo",
  projectId: "p1",
  workspaceId: null,
  planPath: "/repo/.temp-code/plans/project.md",
  threadType: "project-plan",
  status: "idle",
  blocks: [],
} as unknown as Session;

const state = (over: Partial<ProjectPlanState> = {}): ProjectPlanState => ({
  projectId: "p1",
  path: "/repo/.temp-code/plans/project.md",
  exists: true,
  pinned: false,
  sessionId: "pp",
  complete: true,
  milestones: [
    { index: 1, title: "Data model", done: true },
    { index: 2, title: "API", done: false },
    { index: 3, title: "UI", done: false },
  ],
  missing: [],
  ...over,
});

afterEach(() => {
  cleanup();
  for (const fn of Object.values(actions)) fn.mockClear();
});

describe("ProjectPlanCard", () => {
  it("is three buttons naming the next milestone, with no pin", () => {
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} />);
    const card = document.querySelector("[data-project-plan-card]") as HTMLElement;
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Plan milestone 2",
      "Orchestrate milestone 2",
      "Revise…",
    ]);
    expect(screen.queryByText(/project's plan/)).toBeNull();
    expect(screen.queryByText("The plan is complete")).toBeNull();
  });

  it("Plan milestone N starts a planning thread for the first undone milestone and opens it", async () => {
    const onStarted = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan milestone 2" }));
    await act(async () => {});
    expect(actions.startMilestonePlanning).toHaveBeenCalledTimes(1);
    const [s, m] = actions.startMilestonePlanning.mock.calls[0] as unknown as [Session, { index: number; title: string }];
    expect(s.id).toBe("pp");
    expect(m.index).toBe(2);
    expect(m.title).toBe("API");
    expect(onStarted).toHaveBeenCalledWith("plan-m2");
  });

  it("Orchestrate milestone N orchestrates that milestone", async () => {
    const onStarted = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Orchestrate milestone 2" }));
    await act(async () => {});
    expect(actions.startMilestoneOrchestration).toHaveBeenCalledTimes(1);
    expect((actions.startMilestoneOrchestration.mock.calls[0] as unknown as [Session, { index: number }])[1].index).toBe(2);
    expect(onStarted).toHaveBeenCalledWith("orch-m2");
    expect(actions.startMilestonePlanning).not.toHaveBeenCalled();
  });

  it("Revise… asks in a dialog and sends the field's text as a turn in the plan thread", async () => {
    const onChanged = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Revise…" }));
    await act(async () => {});
    expect(screen.getByText("Revise the plan")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What should change"), { target: { value: "drop milestone 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});
    expect(actions.reviseProjectPlan).toHaveBeenCalledWith(session, "drop milestone 3");
    expect(onChanged).toHaveBeenCalled();
  });

  it("an empty Revise sends the re-survey turn", async () => {
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revise…" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});
    expect(actions.reviseProjectPlan).toHaveBeenCalledWith(session, "");
  });

  it("with every milestone done, the two milestone buttons are gone and it says so", () => {
    const done = DOC.replace("### [ ] 2. API", "### [x] 2. API").replace("### [ ] 3. UI", "### [x] 3. UI");
    render(<ProjectPlanCard session={session} doc={done} state={state()} />);
    expect(screen.getByText("Every milestone is done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Plan milestone/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Orchestrate milestone/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Revise…" })).toBeTruthy();
  });
});

describe("ProjectPlanOptions compact", () => {
  it("lists the four actions as rows, the pin among them", async () => {
    const view = render(<ProjectPlanOptions session={session} doc={DOC} state={state()} compact />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Plan milestone 2",
      "Orchestrate milestone 2",
      "Revise the plan",
      "Keep as the project's plan",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Keep as the project's plan" }));
    await act(async () => {});
    expect(actions.pinProjectPlan).toHaveBeenCalledWith("p1", true);
    view.rerender(<ProjectPlanOptions session={session} doc={DOC} state={state({ pinned: true })} compact />);
    expect(screen.getByRole("button", { name: "Stop keeping as the project's plan" })).toBeTruthy();
  });
});

describe("MilestoneList", () => {
  it("renders every milestone with its tick and fields, and the checkbox ticks it by hand", async () => {
    const onTicked = vi.fn();
    render(<MilestoneList doc={DOC} projectId="p1" onTicked={onTicked} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(boxes[1].getAttribute("aria-label")).toBe("Milestone 2: API");
    expect(screen.getByText("schema test passes")).toBeTruthy();
    expect(screen.getByText("Depends on")).toBeTruthy();
    // A long field is read whole: nothing clamps it.
    expect(screen.getByText("tables").className).not.toMatch(/line-clamp-\d/);
    fireEvent.click(boxes[1]);
    await act(async () => {});
    expect(actions.tickMilestone).toHaveBeenCalledWith("p1", 2, true);
    expect(onTicked).toHaveBeenCalled();
    fireEvent.click(boxes[0]);
    await act(async () => {});
    expect(actions.tickMilestone).toHaveBeenLastCalledWith("p1", 1, false);
  });
});
