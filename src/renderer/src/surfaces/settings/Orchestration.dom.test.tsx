// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationRules, RulesCatalog, RulesScope } from "../../lib/tcserver/rules";

const state = vi.hoisted(() => ({
  scope: undefined as RulesScope | undefined,
  catalog: null as RulesCatalog | null,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
}));

vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => state.workspaces }));
vi.mock("../../lib/tcserver/rules", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/rules")>()),
  useRulesScope: () => ({ scope: state.scope, catalog: state.catalog }),
  rulesStore: { save: (...a: unknown[]) => state.save(...(a as [])), clear: (...a: unknown[]) => state.clear(...(a as [])) },
}));

const { OrchestrationPage } = await import("./Orchestration");
const { OrchestrationRulesEditor } = await import("../../chrome/OrchestrationRules");
const { openOrchestrationSettings, takeRequestedRulesFocus } = await import("../../lib/tcserver/rules");
const { OPEN_SETTINGS_EVENT } = await import("../../lib/monaco/debugTab");
// ChoiceSelect rides a lazy chunk; load it so the comboboxes render at once.
await (await import("../chunks")).selectChunk.load();

const CATALOG: RulesCatalog = {
  claude: {
    id: "claude",
    label: "Claude",
    defaultModel: "opus",
    models: [
      { id: "opus", label: "Opus", reasoning: ["low", "medium", "high"] },
      { id: "haiku", label: "Haiku", reasoning: [] },
    ],
  },
  codex: { id: "codex", label: "Codex", defaultModel: "sol", models: [{ id: "sol", label: "Sol", reasoning: ["low", "high"] }] },
};

function rules(patch: Partial<OrchestrationRules> = {}): OrchestrationRules {
  return {
    conduct: {
      delegation: "strict",
      selfEdit: false,
      selfShell: true,
      verifyResults: true,
      escalate: true,
      useWorktrees: true,
      maxParallel: 4,
      maxAgents: 0,
    },
    models: { "claude:opus": { approved: true }, "claude:haiku": { approved: "orchestrators" } },
    routing: [
      { id: "r1", task: "Bulk work", provider: "codex", model: "sol", reasoning: "high", enabled: true },
      { id: "r2", task: "Reviews", provider: "claude", model: "opus", reasoning: "medium", enabled: true },
    ],
    ...patch,
  } as OrchestrationRules;
}

const saved = () => (state.save.mock.calls.at(-1) as unknown[] | undefined)?.[2] as OrchestrationRules;

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

async function openMenu(row: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(row).getByRole("button", { name: "Rule actions" }));
  });
}

const ruleRow = (task: string) => screen.getByText(task).closest<HTMLElement>("[data-slot=page-row]")!;

beforeEach(() => {
  state.scope = { rules: rules(), overridden: false };
  state.catalog = CATALOG;
  state.workspaces = [];
  state.save.mockClear();
  state.clear.mockClear();
});
afterEach(cleanup);

describe("Orchestration page", () => {
  it("shows skeleton rows under the real heading before the scope loads", () => {
    state.scope = undefined;
    render(<OrchestrationPage />);
    expect(screen.getByTestId("rules-skeleton")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Conduct" })).toBeTruthy();
  });

  it("is the global rules alone: no scope picker", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    render(<OrchestrationPage />);
    expect(screen.queryByRole("combobox", { name: "Rules for" })).toBeNull();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("saves a Conduct switch through the rules store", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Edit files itself" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", null, expect.anything());
    expect(saved().conduct.selfEdit).toBe(true);
  });

  it("describes Delegation by its value", async () => {
    const { rerender } = render(<OrchestrationPage />);
    expect(screen.getByText("Delegates everything; the orchestrator never does the work itself.")).toBeTruthy();
    state.scope = { rules: rules({ conduct: { ...rules().conduct, delegation: "free" } }), overridden: false };
    rerender(<OrchestrationPage />);
    expect(screen.getByText("May work directly whenever that is faster.")).toBeTruthy();
  });

  it("offers Reset on the global rules", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    });
    expect(state.clear).toHaveBeenCalledWith("local", null);
  });

  it("offers Remove override only on an overriding workspace", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    state.scope = { rules: rules(), overridden: true };
    const { unmount } = render(<OrchestrationRulesEditor workspaceId="w1" />);
    expect(screen.getByRole("region", { name: "Orchestration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove override" })).toBeTruthy();
    expect(screen.getByText("This workspace overrides the global rules.")).toBeTruthy();
    unmount();
    state.scope = { rules: rules(), overridden: false };
    render(<OrchestrationRulesEditor workspaceId="w1" />);
    expect(screen.queryByRole("button", { name: "Remove override" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.getByText("Following the global rules. A change makes an override.")).toBeTruthy();
  });

  it("lists the models in one table with a group row per provider", () => {
    render(<OrchestrationPage />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Model", "Spawned by", "Effort"]);
    const groups = table.querySelectorAll("[data-slot=table-group-row]");
    expect([...groups].map((g) => g.textContent)).toEqual(["Claude", "Codex"]);
  });

  it("patches approved from Spawned by", async () => {
    render(<OrchestrationPage />);
    await choose(screen.getByRole("combobox", { name: "Who may spawn Opus" }), "Orchestrators only");
    expect(saved().models["claude:opus"].approved).toBe("orchestrators");
    await choose(screen.getByRole("combobox", { name: "Who may spawn Sol" }), "Everyone");
    expect(saved().models["codex:sol"].approved).toBe(true);
    await choose(screen.getByRole("combobox", { name: "Who may spawn Opus" }), "Off");
    expect(saved().models["claude:opus"]).toBeUndefined();
  });

  it("shows effort selects only for an approved model with a ladder", () => {
    render(<OrchestrationPage />);
    expect(screen.getByRole("combobox", { name: "Opus lowest effort" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Haiku lowest effort" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sol lowest effort" })).toBeNull();
  });

  it("says Not approved on a rule whose model is off", () => {
    render(<OrchestrationPage />);
    const row = ruleRow("Bulk work");
    expect(within(row).getByText("Not approved").className).toContain("text-warning");
    expect(within(ruleRow("Reviews")).queryByText("Not approved")).toBeNull();
  });

  it("moves a rule down, and not past the last", async () => {
    render(<OrchestrationPage />);
    await openMenu(ruleRow("Reviews"));
    expect(screen.getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")).toBe("true");
    cleanup();
    render(<OrchestrationPage />);
    await openMenu(ruleRow("Bulk work"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    });
    expect(saved().routing.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("saves a new rule's trimmed task, never an empty one", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("When the task is"), { target: { value: "  Docs  " } });
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(saved().routing.at(-1)?.task).toBe("Docs");
  });

  it("shows an empty state with no rules", () => {
    state.scope = { rules: rules({ routing: [] }), overridden: false };
    render(<OrchestrationPage />);
    expect(screen.getByText("No rules. Subagents use each provider's default model.")).toBeTruthy();
  });

  it("opens a workspace's rules on its page, and the global rules on this one", () => {
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listen);
    openOrchestrationSettings("w1");
    expect(takeRequestedRulesFocus()).toBe(true);
    expect(takeRequestedRulesFocus()).toBe(false);
    openOrchestrationSettings(null);
    expect(takeRequestedRulesFocus()).toBe(false);
    window.removeEventListener(OPEN_SETTINGS_EVENT, listen);
    expect(seen).toEqual(["ws:w1", "orchestration"]);
  });
});
