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
  SplitShell: (p: { board: React.ReactNode; collapsed: boolean; title?: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode; onToggleChat: (open: boolean) => void }) => (
    <div data-collapsed={String(p.collapsed)}>
      <header data-view-header>
        <span data-view-title>{p.title}</span>
        <span data-view-detail>{p.detail}</span>
        {p.actions}
      </header>
      {p.board}
      <button type="button" onClick={() => p.onToggleChat(false)}>
        fold
      </button>
      <button type="button" onClick={() => p.onToggleChat(true)}>
        open
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
  it("clips horizontal overhang in its plan scroller", () => {
    doc = "# A plan\n\n## Tasks\n- [ ] one\n";
    const { container } = render(<PlanView {...props(session({}))} />);
    expect(container.querySelector(".overflow-y-auto")?.classList.contains("overflow-x-hidden")).toBe(true);
  });

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

  it("a chat reopened on a settled plan stays open when the file arrives after the remount", () => {
    const text = "# A plan\n\n## Tasks\n- [ ] one\n";
    const settled = session({ status: "idle" });
    // usePlanFile answers null until it has read the file.
    const mount = () => {
      doc = null;
      const view = render(<PlanView {...props(settled)} />);
      doc = text;
      view.rerender(<PlanView {...props({ ...settled } as Session)} />);
    };
    mount();
    expect(collapsed()).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    cleanup();
    mount();
    expect(collapsed()).toBe("false");
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

describe("PlanView's header", () => {
  it("is titled by the plan's # heading, never \"Plan\" twice, and the document starts under it", () => {
    doc = "# Ship the raids\n\nWhy we do it.\n\n## Tasks\n- [ ] one\n- [ ] two\n";
    render(<PlanView {...props(session({ status: "idle" }))} />);
    expect(document.querySelector("[data-view-title]")?.textContent).toBe("Ship the raids");
    const header = document.querySelector("[data-view-header]") as HTMLElement;
    expect(header.textContent).not.toMatch(/Plan.*Plan/);
    const body = [...document.querySelectorAll("[data-md]")].map((e) => e.textContent).join("");
    expect(body).not.toContain("# Ship the raids");
    expect(body).toContain("Why we do it.");
  });

  it("falls back to the thread's title before the plan has a heading", () => {
    doc = "## Tasks\n- [ ] one\n";
    render(<PlanView {...props(session({}))} />);
    expect(document.querySelector("[data-view-title]")?.textContent).toBe("A plan");
  });

  it("points at the build with its status glyph 8px from its word", () => {
    doc = "# Ship the raids\n\n## Tasks\n- [ ] one\n";
    metas.impl = { id: "impl", environmentId: "local", threadType: "implementation", status: "running", title: "Build" };
    render(<PlanView {...props(session({ status: "idle", implementationId: "impl" } as Partial<Session>))} />);
    const handoff = screen.getByRole("button", { name: /Implementation/ });
    expect(handoff.className).toContain("gap-2");
    expect((handoff.querySelector("[data-slot=status-mark]") as HTMLElement).className).not.toContain("ml-1");
    delete metas.impl;
  });
});
