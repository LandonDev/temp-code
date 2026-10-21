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

import { MilestoneList, ProjectPlanCard } from "./ProjectPlanCard";

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
  it("offers the four options and names the next milestone", () => {
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} />);
    expect(screen.getByText("The plan is complete")).toBeTruthy();
    expect(screen.getByText("1 of 3 milestones done")).toBeTruthy();
    expect(screen.getByText("Plan the next milestone")).toBeTruthy();
    expect(screen.getByText("2. API")).toBeTruthy();
    expect(screen.getByText("Start an orchestration thread for milestone 2")).toBeTruthy();
    expect(screen.getByText("Revise the plan")).toBeTruthy();
    expect(screen.getByText("Keep as the project's plan")).toBeTruthy();
  });

  it("Plan the next milestone starts a planning thread for the first undone milestone and opens it", async () => {
    const onStarted = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onStarted={onStarted} />);
    fireEvent.click(screen.getByText("Plan the next milestone"));
    await act(async () => {});
    expect(actions.startMilestonePlanning).toHaveBeenCalledTimes(1);
    const [s, m] = actions.startMilestonePlanning.mock.calls[0] as unknown as [Session, { index: number; title: string }];
    expect(s.id).toBe("pp");
    expect(m.index).toBe(2);
    expect(m.title).toBe("API");
    expect(onStarted).toHaveBeenCalledWith("plan-m2");
  });

  it("Start an orchestration thread for milestone N orchestrates that milestone", async () => {
    const onStarted = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onStarted={onStarted} />);
    fireEvent.click(screen.getByText("Start an orchestration thread for milestone 2"));
    await act(async () => {});
    expect(actions.startMilestoneOrchestration).toHaveBeenCalledTimes(1);
    expect((actions.startMilestoneOrchestration.mock.calls[0] as unknown as [Session, { index: number }])[1].index).toBe(2);
    expect(onStarted).toHaveBeenCalledWith("orch-m2");
    expect(actions.startMilestonePlanning).not.toHaveBeenCalled();
  });

  it("Revise the plan asks what should change and sends it as a turn in the plan thread", async () => {
    const onChanged = vi.fn();
    render(<ProjectPlanCard session={session} doc={DOC} state={state()} onChanged={onChanged} />);
    fireEvent.click(screen.getByText("Revise the plan"));
    const field = screen.getByLabelText("What should change");
    fireEvent.change(field, { target: { value: "drop milestone 3" } });
    fireEvent.submit(field.closest("form")!);
    await act(async () => {});
    expect(actions.reviseProjectPlan).toHaveBeenCalledWith(session, "drop milestone 3");
    expect(onChanged).toHaveBeenCalled();
  });

  it("Keep as the project's plan pins it, and reads as unpin once pinned", async () => {
    const view = render(<ProjectPlanCard session={session} doc={DOC} state={state()} />);
    fireEvent.click(screen.getByText("Keep as the project's plan"));
    await act(async () => {});
    expect(actions.pinProjectPlan).toHaveBeenCalledWith("p1", true);
    view.rerender(<ProjectPlanCard session={session} doc={DOC} state={state({ pinned: true })} />);
    expect(screen.getByText("Stop keeping as the project's plan")).toBeTruthy();
    fireEvent.click(screen.getByText("Stop keeping as the project's plan"));
    await act(async () => {});
    expect(actions.pinProjectPlan).toHaveBeenLastCalledWith("p1", false);
  });

  it("with every milestone done, the two start options are disabled and say so", () => {
    const done = DOC.replace("### [ ] 2. API", "### [x] 2. API").replace("### [ ] 3. UI", "### [x] 3. UI");
    render(<ProjectPlanCard session={session} doc={done} state={state()} />);
    expect(screen.getByText("Every milestone is done")).toBeTruthy();
    expect((screen.getByText("Plan the next milestone").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Start an orchestration thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MilestoneList", () => {
  it("renders every milestone with its tick and fields, and a click ticks it by hand", async () => {
    const onTicked = vi.fn();
    render(<MilestoneList doc={DOC} projectId="p1" onTicked={onTicked} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(screen.getByText("schema test passes")).toBeTruthy();
    expect(screen.getByText("Depends on")).toBeTruthy();
    fireEvent.click(boxes[1]);
    await act(async () => {});
    expect(actions.tickMilestone).toHaveBeenCalledWith("p1", 2, true);
    expect(onTicked).toHaveBeenCalled();
    fireEvent.click(boxes[0]);
    await act(async () => {});
    expect(actions.tickMilestone).toHaveBeenLastCalledWith("p1", 1, false);
  });
});
