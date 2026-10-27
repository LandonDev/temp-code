// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";

let doc: string | null = null;
vi.mock("../../hooks/usePlanFile", () => ({ usePlanFile: () => doc }));
vi.mock("../../lib/projectPlan", () => ({
  useProjectPlan: () => ({ pinned: true, milestones: [{ index: 1, title: "A", done: false }] }),
  loadProjectPlan: vi.fn(),
}));
vi.mock("../../lib/tcserver/commands", () => ({ readFile: async () => "" }));
vi.mock("../../lib/tcserver/plans", () => ({ implementPlan: vi.fn() }));
vi.mock("../../chrome/ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("../../chrome/ModelSettings", () => ({ ModelSettings: () => null }));
vi.mock("../../chrome/AccessPicker", () => ({ AccessPicker: () => null }));
vi.mock("../../chrome/ThreadTune", () => ({ ThreadTune: () => null, normalizeTune: () => undefined, tuneSummary: () => null }));
vi.mock("../../lib/models", () => ({ mergeModelSettings: (_m: unknown, s: unknown) => s, nativeModelId: (m: string) => m, resolveModel: () => null }));
vi.mock("../AgentMarkdown", () => ({ AgentMarkdown: ({ text }: { text: string }) => <pre data-md>{text}</pre> }));
vi.mock("./SplitShell", () => ({
  SplitShell: ({ board, chat }: { board: React.ReactNode; chat: React.ReactNode }) => (
    <div>
      {board}
      {chat}
    </div>
  ),
}));
vi.mock("./ProjectPlanCard", () => ({
  MilestoneList: () => <ol data-milestones />,
  ProjectPlanCard: () => <section data-project-plan-card>options</section>,
}));

import { PlanView } from "./PlanView";

const session = (over: Partial<Session>): Session =>
  ({
    id: "pp",
    environmentId: "local",
    harness: "claude",
    model: "claude-haiku-5-5",
    modelSettings: {},
    runtimeMode: "ask",
    title: "Project plan",
    cwd: "/repo",
    projectId: "p1",
    planPath: "/repo/.temp-code/plans/project.md",
    threadType: "project-plan",
    status: "idle",
    blocks: [],
    ...over,
  }) as unknown as Session;

const props = (s: Session) =>
  ({ session: s, renderChat: () => null, onOpenFile: () => {}, onOpenDiff: () => {} }) as unknown as Parameters<typeof PlanView>[0];

afterEach(cleanup);

const PLAN = `# Acme\n\n## Goals\ngo\n\n## Milestones\n\n### [ ] 1. A\n- Scope: x\n\n## Risks\nr\n`;

describe("PlanView for a project plan", () => {
  it("shows the milestones live, never a Start button, and the options card once complete", () => {
    doc = PLAN;
    const view = render(<PlanView {...props(session({}))} />);
    expect(screen.getByText("Project plan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
    expect(document.querySelector("[data-milestones]")).toBeTruthy();
    // The milestone's own ### section folds into the list rather than printing.
    expect([...document.querySelectorAll("[data-md]")].map((e) => e.textContent).join("")).not.toContain("### [ ] 1. A");
    expect(document.querySelector("[data-project-plan-card]")).toBeNull();
    expect(screen.getByText("0 of 1 milestone done")).toBeTruthy();
    expect(screen.getByText("Project's plan")).toBeTruthy();
    view.unmount();
    doc = `---\nstatus: complete\n---\n${PLAN}`;
    render(<PlanView {...props(session({}))} />);
    expect(document.querySelector("[data-project-plan-card]")).toBeTruthy();
  });

  it("hides the card while the thread runs or waits", () => {
    doc = `---\nstatus: complete\n---\n${PLAN}`;
    render(<PlanView {...props(session({ status: "running" }))} />);
    expect(document.querySelector("[data-project-plan-card]")).toBeNull();
  });

  it("an ordinary plan keeps its Start button", () => {
    doc = "# Plan\n\n## Tasks\n- [ ] a\n";
    render(<PlanView {...props(session({ threadType: "planning", planPath: "/repo/.temp-code/plan-x.md" }))} />);
    expect(screen.getByRole("button", { name: /^Start/ })).toBeTruthy();
    expect(document.querySelector("[data-project-plan-card]")).toBeNull();
  });
});
