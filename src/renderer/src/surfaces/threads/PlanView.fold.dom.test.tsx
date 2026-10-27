// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  SplitShell: (p: { board: React.ReactNode; collapsed: boolean; onToggleChat: (open: boolean) => void }) => (
    <div data-collapsed={String(p.collapsed)}>
      {p.board}
      <button type="button" onClick={() => p.onToggleChat(false)}>
        fold
      </button>
    </div>
  ),
}));

import { resetChatFolds } from "../../lib/chatFold";
import { PlanView } from "./PlanView";

const session = (over: Partial<Session>): Session =>
  ({
    id: "plan",
    environmentId: "local",
    harness: "claude",
    model: "claude-haiku-5-5",
    modelSettings: {},
    runtimeMode: "ask",
    title: "A plan",
    cwd: "/repo",
    projectId: "p1",
    planPath: "/repo/.temp-code/plan-x.md",
    threadType: "planning",
    status: "running",
    blocks: [],
    ...over,
  }) as unknown as Session;

const props = (s: Session) =>
  ({ session: s, renderChat: () => null, onOpenFile: () => {}, onOpenDiff: () => {} }) as unknown as Parameters<typeof PlanView>[0];

afterEach(() => {
  cleanup();
  resetChatFolds();
});

const collapsed = () => document.querySelector("[data-collapsed]")?.getAttribute("data-collapsed");

describe("PlanView's chat fold", () => {
  it("survives the view unmounting, as a tab switch does", () => {
    doc = "# A plan\n\n## Tasks\n- [ ] one\n";
    render(<PlanView {...props(session({}))} />);
    expect(collapsed()).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "fold" }));
    expect(collapsed()).toBe("true");
    cleanup();
    render(<PlanView {...props(session({}))} />);
    expect(collapsed()).toBe("true");
  });

  it("is per thread: another plan opens on its own default", () => {
    doc = "# A plan\n";
    render(<PlanView {...props(session({}))} />);
    fireEvent.click(screen.getByRole("button", { name: "fold" }));
    cleanup();
    render(<PlanView {...props(session({ id: "other" }))} />);
    expect(collapsed()).toBe("false");
  });
});
