// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspace: { id: "w1", name: "Alpha", path: "/w/alpha", environmentId: "local", accountPins: {} as Record<string, string> },
  projects: [] as { id: string; workspaceId: string; name: string; archived: boolean; accountPins?: Record<string, string> }[],
  overridden: false,
  focus: false,
  rulesFocus: false,
  setAccounts: vi.fn(async () => {}),
}));

const profile = (name: string) => ({ name, email: `${name}@example.com` });

vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../chrome/ThreadDefaultsDialog", () => ({ ThreadDefaultsEditor: () => <h2>New threads</h2> }));
vi.mock("../../chrome/TurnPassFields", () => ({ TurnPassEditor: () => <h2>Completed turn</h2> }));
vi.mock("../../chrome/ProjectDialogs", () => ({
  ProjectSettingsDialog: ({ project }: { project: { name: string } }) => <div role="dialog">{project.name} settings</div>,
}));
vi.mock("../../chrome/rail/buildSettings", () => ({
  BuildEditor: () => <div data-testid="build-editor" />,
  takeRequestedBuildFocus: () => {
    const focus = state.focus;
    state.focus = false;
    return focus;
  },
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [state.workspace],
  useProjects: () => state.projects,
}));
vi.mock("../../lib/tcserver/rules", () => ({
  takeRequestedRulesFocus: () => {
    const focus = state.rulesFocus;
    state.rulesFocus = false;
    return focus;
  },
}));
vi.mock("../../chrome/OrchestrationRules", () => ({
  OrchestrationRulesEditor: ({ workspaceId }: { workspaceId: string }) => <h2>Orchestration {workspaceId}</h2>,
}));
vi.mock("../../lib/tcserver/projects", () => ({
  setWorkspaceAccounts: (...a: unknown[]) => state.setAccounts(...(a as [])),
}));
vi.mock("../../stores/accounts", () => ({
  useAccounts: () => ({
    snapshot: {
      providers: {
        claude: { profiles: [profile("alice"), profile("bob")] },
        codex: { profiles: [profile("carol")] },
        cursor: { profiles: [] },
      },
    },
  }),
}));

const { WorkspacePage } = await import("./Workspace");
// ChoiceSelect rides a lazy chunk; load it so the comboboxes render at once.
await (await import("../chunks")).selectChunk.load();

const projectRows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-slot=page-row]")].filter((row) => row.querySelector("[aria-label$=' settings']"));

async function choose(trigger: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(trigger);
  });
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

beforeEach(() => {
  state.workspace = { ...state.workspace, accountPins: {} };
  state.projects = [];
  state.overridden = false;
  state.focus = false;
  state.rulesFocus = false;
  state.setAccounts.mockClear();
});
afterEach(cleanup);

describe("Workspace page", () => {
  it("orders its sections", () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "New threads",
      "Completed turn",
      "Accounts",
      "Build",
      "Orchestration w1",
      "Projects",
    ]);
  });

  it("pins an account and removes the pin on Auto", async () => {
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude Code account" }), "bob");
    expect(state.setAccounts).toHaveBeenLastCalledWith("w1", { claude: "bob" });
    cleanup();
    state.workspace = { ...state.workspace, accountPins: { claude: "bob", codex: "carol" } };
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude Code account" }), "Auto");
    expect(state.setAccounts).toHaveBeenLastCalledWith("w1", { codex: "carol" });
  });

  it("names a pin Aliax does not know", () => {
    state.workspace = { ...state.workspace, accountPins: { claude: "gone" } };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getByRole("combobox", { name: "Claude Code account" }).textContent).toContain("gone (not in Aliax)");
  });

  it("shows a failed pin under its row", async () => {
    state.setAccounts.mockImplementationOnce(async () => {
      throw new Error("refused: offline");
    });
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude Code account" }), "bob");
    expect(screen.getByText("refused: offline").className).toContain("text-destructive");
  });

  it("lists this workspace's live projects with their pins", () => {
    state.projects = [
      { id: "p1", workspaceId: "w1", name: "App", archived: false, accountPins: { claude: "alice", codex: "carol" } },
      { id: "p2", workspaceId: "w1", name: "Docs", archived: false },
      { id: "p3", workspaceId: "w1", name: "Old", archived: true },
      { id: "p4", workspaceId: "w2", name: "Elsewhere", archived: false },
    ];
    render(<WorkspacePage workspaceId="w1" />);
    const rows = projectRows();
    expect(rows.map((r) => r.querySelector("[data-slot=item-title]")?.textContent)).toEqual(["App", "Docs"]);
    expect(rows[0].textContent).toContain("alice");
    expect(rows[0].textContent).toContain("carol");
    expect(rows[1].querySelector("[data-slot=item-description]")).toBeNull();
  });

  it("shows the workspace's pin on a project that pins nothing itself", () => {
    state.workspace = { ...state.workspace, accountPins: { claude: "alice" } };
    state.projects = [
      { id: "p1", workspaceId: "w1", name: "App", archived: false, accountPins: { claude: "bob" } },
      { id: "p2", workspaceId: "w1", name: "Docs", archived: false },
    ];
    render(<WorkspacePage workspaceId="w1" />);
    const [app, docs] = projectRows().map((r) => r.querySelector("[data-slot=item-description]")?.textContent);
    expect(app).toBe("bob");
    expect(docs).toBe("alice");
  });

  it("opens a project's settings from its row", async () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    render(<WorkspacePage workspaceId="w1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    });
    expect(screen.getByRole("dialog").textContent).toBe("App settings");
  });

  it("scrolls the Build section into view when the rail asked for it", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    state.focus = true;
    render(<WorkspacePage workspaceId="w1" />);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("settings-build"));
    expect(document.activeElement).toBe(document.getElementById("settings-build"));
  });

  it("focuses the rules when the workspace menu asked for them", () => {
    Element.prototype.scrollIntoView = vi.fn();
    state.rulesFocus = true;
    render(<WorkspacePage workspaceId="w1" />);
    expect(document.activeElement).toBe(document.getElementById("settings-orchestration"));
  });
});
