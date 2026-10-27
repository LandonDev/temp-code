// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";

let doc: string | null = null;
vi.mock("../../hooks/usePlanFile", () => ({ usePlanFile: () => doc }));
let pinned = true;
const pinProjectPlan = vi.fn(async () => {});
vi.mock("../../lib/projectPlan", () => ({
  useProjectPlan: () => ({ pinned, milestones: [{ index: 1, title: "A", done: false }] }),
  loadProjectPlan: vi.fn(),
  pinProjectPlan: (...a: unknown[]) => pinProjectPlan(...(a as [])),
}));
const metas: Record<string, unknown> = {};
vi.mock("../../lib/tcserver/store", () => ({
  sessionStore: {
    onMetaChange: () => () => {},
    metaOf: (id: string) => metas[id] ?? null,
    metas: () => [],
  },
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
  SplitShell: (p: { board: React.ReactNode; chat: React.ReactNode; title?: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <header data-view-header>
        <span>{p.title}</span>
        <span>{p.detail}</span>
        {p.actions}
      </header>
      {p.board}
      {p.chat}
    </div>
  ),
}));
vi.mock("./ProjectPlanCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProjectPlanCard")>()),
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
    expect(screen.getByRole("button", { name: "Project's plan" }).getAttribute("aria-pressed")).toBe("true");
    view.unmount();
    doc = `---\nstatus: complete\n---\n${PLAN}`;
    render(<PlanView {...props(session({}))} />);
    expect(document.querySelector("[data-project-plan-card]")).toBeTruthy();
  });

  it("the header's pin toggle reflects the pin and flips it", async () => {
    doc = PLAN;
    pinned = false;
    render(<PlanView {...props(session({}))} />);
    const pin = screen.getByRole("button", { name: "Project's plan" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    await act(async () => {});
    expect(pinProjectPlan).toHaveBeenCalledWith("p1", true);
    pinned = true;
  });

  it("hides the card while the thread runs or waits", () => {
    doc = `---\nstatus: complete\n---\n${PLAN}`;
    render(<PlanView {...props(session({ status: "running" }))} />);
    expect(document.querySelector("[data-project-plan-card]")).toBeNull();
  });

  it("an ordinary plan's header has Start build and counts its tasks", () => {
    doc = "# Plan\n\n## Tasks\n- [ ] a\n- [ ] b\n";
    render(<PlanView {...props(session({ threadType: "planning", planPath: "/repo/.temp-code/plan-x.md" }))} />);
    const header = document.querySelector("[data-view-header]") as HTMLElement;
    expect(header.textContent).toContain("Plan");
    expect(header.textContent).toContain("2 tasks");
    expect(header.textContent).not.toContain("·");
    expect(screen.getByRole("button", { name: "Start build" })).toBeTruthy();
    expect(document.querySelector("[data-project-plan-card]")).toBeNull();
    // Written and settled with no build: the Plan ready mark carries the count.
    const mark = header.querySelector("[data-plan-ready]");
    expect(mark?.getAttribute("data-state")).toBe("plan-ready");
    expect(mark?.textContent).toBe("Plan ready2 tasks");
  });

  it("a plan still being written shows its count alone", () => {
    doc = "# Plan\n\n## Tasks\n- [ ] a\n";
    render(<PlanView {...props(session({ threadType: "planning", status: "running", planPath: "/repo/.temp-code/plan-x.md" }))} />);
    const header = document.querySelector("[data-view-header]") as HTMLElement;
    expect(header.querySelector("[data-plan-ready]")).toBeNull();
    expect(header.textContent).toContain("1 task");
  });

  it("once the build exists the header opens it instead of offering Start", () => {
    doc = "# Plan\n\n## Tasks\n- [ ] a\n";
    metas["build-1"] = { id: "build-1", threadType: "implementation", status: "running", planPath: "/repo/.temp-code/plan-x.md" };
    const onOpenSession = vi.fn();
    render(
      <PlanView
        {...props(session({ threadType: "planning", planPath: "/repo/.temp-code/plan-x.md", implementationId: "build-1" }))}
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.queryByRole("button", { name: "Start build" })).toBeNull();
    expect(document.querySelector("[data-plan-ready]")).toBeNull();
    const handoff = screen.getByRole("button", { name: /Implementation/ });
    expect(handoff.textContent).toContain("Working");
    fireEvent.click(handoff);
    expect(onOpenSession).toHaveBeenCalledWith("build-1");
    delete metas["build-1"];
  });
});
