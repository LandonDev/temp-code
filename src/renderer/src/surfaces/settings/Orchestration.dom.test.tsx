// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";
import type { OrchestrationRules, RulesCatalog, RulesScope } from "../../lib/tcserver/rules";

const state = vi.hoisted(() => ({
  scope: undefined as RulesScope | undefined,
  catalog: null as RulesCatalog | null,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  save: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  clear: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
  toastError: vi.fn(),
  error: null as string | null,
  retry: vi.fn(),
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/connection/status", () => ({ useEnvironmentStatuses: () => new Map() }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: state.toastError }) }));
vi.mock("../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => state.workspaces }));
vi.mock("../../lib/tcserver/rules", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/rules")>()),
  useRulesScope: () => ({ scope: state.scope, catalog: state.catalog, error: state.error, retry: state.retry }),
  rulesStore: {
    save: (...a: unknown[]) => state.save(...a),
    clear: (...a: unknown[]) => state.clear(...(a as [])),
    load: (...a: unknown[]) => state.load(...(a as [])),
  },
}));

const { OrchestrationPage } = await import("./Orchestration");
const shared = await import("@server/shared/rules");
const catalogModule = await import("@server/shared/catalog");
const { OrchestrationRulesEditor } = await import("../../chrome/OrchestrationRules");
const { ConfirmHost } = await import("../../chrome/ConfirmDialog");
const { openOrchestrationSettings, takeRequestedRulesFocus } = await import("../../lib/tcserver/rules");
const { OPEN_SETTINGS_EVENT } = await import("../../lib/monaco/debugTab");

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

async function openRule(task: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: `Edit rule: ${task}` }));
  });
  return screen.findByRole("dialog");
}

async function saveDialog(dialog: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
}

const ruleRow = (task: string) => screen.getByText(task).closest<HTMLElement>("[data-slot=page-row]")!;

beforeEach(() => {
  state.scope = { rules: rules(), overridden: false };
  state.catalog = CATALOG;
  state.workspaces = [];
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  state.clear.mockClear();
  state.load.mockClear();
  state.toastError.mockClear();
  state.error = null;
  state.retry.mockClear();
});
afterEach(cleanup);

describe("Orchestration page", () => {
  it("shows skeleton rows under the real heading before the scope loads", () => {
    state.scope = undefined;
    render(<OrchestrationPage />);
    expect(screen.getByTestId("rules-skeleton")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Conduct" })).toBeTruthy();
    // The rows in their shape: Delegation's select first, then the switches.
    const rows = [...document.querySelectorAll<HTMLElement>("[data-slot=page-row-skeleton]")];
    expect(rows.map((r) => r.dataset.control)).toEqual(["select", "switch", "switch", "switch", "switch", "switch", "select", "select"]);
  });

  it("ends the skeleton when rules.get does not answer: the host's words and Retry", () => {
    state.scope = undefined;
    state.error = "The host did not answer";
    render(<OrchestrationPage />);
    const conduct = screen.getByRole("region", { name: "Conduct" });
    expect(screen.queryByTestId("rules-skeleton")).toBeNull();
    expect(within(conduct).getByRole("alert").textContent).toBe("The host did not answer");
    fireEvent.click(within(conduct).getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
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
      fireEvent.click(screen.getByRole("switch", { name: "File edits" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", null, expect.anything());
    expect(saved().conduct.selfEdit).toBe(true);
  });

  it("names the checking switch with a noun", () => {
    render(<OrchestrationPage />);
    const conduct = screen.getByRole("region", { name: "Conduct" });
    expect(within(conduct).getByRole("switch", { name: "Result checks" })).toBeTruthy();
    expect(conduct.textContent).not.toContain("Report checks");
  });

  it("describes Delegation by its value", async () => {
    const { rerender } = render(<OrchestrationPage />);
    expect(screen.getByText("Delegates everything; the orchestrator never does the work itself.")).toBeTruthy();
    state.scope = { rules: rules({ conduct: { ...rules().conduct, delegation: "free" } }), overridden: false };
    rerender(<OrchestrationPage />);
    expect(screen.getByText("May work directly whenever that is faster.")).toBeTruthy();
  });

  it("offers Reset on the global rules only while they differ from the defaults", () => {
    state.scope = { rules: rules(), overridden: false };
    render(<OrchestrationPage />);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("asks before the global Reset, which wipes every rule, and resets only on the verb", async () => {
    state.scope = { rules: rules(), overridden: true };
    render(
      <>
        <OrchestrationPage />
        <ConfirmHost />
      </>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset" })));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Reset rules");
    expect(state.clear).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Reset rules" })));
    expect(state.clear).toHaveBeenCalledWith("local", null);
  });

  it("slides a refused change back and says why in its own section", async () => {
    state.save.mockRejectedValueOnce(new Error("refused: settings of the rules live on box; it is offline"));
    render(<OrchestrationPage />);
    const edits = screen.getByRole("switch", { name: "File edits" });
    expect(edits.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(edits));
    expect(screen.getByRole("switch", { name: "File edits" }).getAttribute("aria-checked")).toBe("false");
    const conduct = screen.getByRole("region", { name: "Conduct" });
    expect(within(conduct).getByRole("alert").textContent).toContain("it is offline");
    expect(within(screen.getByRole("region", { name: "Routing" })).queryByRole("alert")).toBeNull();
  });

  it("offers Remove override only on an overriding workspace", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    state.scope = { rules: rules(), overridden: true };
    const { unmount } = render(<OrchestrationRulesEditor workspaceId="w1" />);
    expect(screen.getByRole("region", { name: "Orchestration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove override" })).toBeTruthy();
    expect(screen.getByText("Overrides the global rules.")).toBeTruthy();
    unmount();
    state.scope = { rules: rules(), overridden: false };
    render(<OrchestrationRulesEditor workspaceId="w1" />);
    expect(screen.queryByRole("button", { name: "Remove override" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.getByText("Follows the global rules.")).toBeTruthy();
  });

  it("names the models section for subagents once, and leaves obvious rows bare", () => {
    render(<OrchestrationPage />);
    const models = screen.getByRole("region", { name: "Subagent models" });
    expect(models.textContent).toContain("A thread may run any model.");
    expect(models.textContent).not.toContain("Applies to subagents");
    expect(screen.queryByText("Running at once.")).toBeNull();
    expect(screen.queryByText("Check results before relaying them.")).toBeNull();
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
    // Off is kept as a decision: a probed row the rules lack takes its default.
    expect(saved().models["claude:opus"]).toEqual({ approved: false });
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

  it("gives each rule row one control, the row itself", () => {
    state.scope = { rules: rules({ routing: [...rules().routing.slice(0, 1), { ...rules().routing[1], enabled: false }] }), overridden: false };
    render(<OrchestrationPage />);
    for (const task of ["Bulk work", "Reviews"]) {
      const row = ruleRow(task);
      const controls = row.querySelectorAll("button, [role=switch], input, select, a");
      expect(controls).toHaveLength(1);
      expect(controls[0].getAttribute("aria-label")).toBe(`Edit rule: ${task}`);
    }
    expect(within(ruleRow("Reviews")).getByText("Off")).toBeTruthy();
    // The facts stay with the button for a screen reader, Off first.
    const reviews = screen.getByRole("button", { name: "Edit rule: Reviews" });
    expect(document.getElementById(reviews.getAttribute("aria-describedby")!)?.textContent).toMatch(/^Off/);
    expect(within(ruleRow("Bulk work")).queryByText("Off")).toBeNull();
  });

  it("turns a rule off from its dialog", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("switch", { name: "Enabled" }));
    });
    await saveDialog(dialog);
    expect(saved().routing.find((r) => r.id === "r2")?.enabled).toBe(false);
  });

  it("reorders a rule from its dialog's Position", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Bulk work");
    await choose(within(dialog).getByRole("combobox", { name: "Position" }), "2");
    await saveDialog(dialog);
    expect(saved().routing.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("is the one dialog shape, Delete a quiet action at the footer's start", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    expectModalShape(dialog);
    const del = within(dialog).getByRole("button", { name: "Delete" });
    expect(del.closest("[data-footer-start]")).not.toBeNull();
    expect(del.getAttribute("data-variant")).toBe("ghost");
  });

  it("lays the rule's fields on Field and FieldRow: the task over its field, each choice a row", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    expect(dialog.querySelectorAll('[data-slot="dialog-field"]')).toHaveLength(1);
    const rows = [...dialog.querySelectorAll('[data-slot="dialog-field-row"]')].map((r) => r.querySelector('[data-slot="item-title"]')?.textContent);
    expect(rows).toContain("Enabled");
    const enabled = within(dialog).getByRole("switch", { name: "Enabled" });
    expect(enabled.closest('[data-slot="dialog-field-row"]')).not.toBeNull();
  });

  it("deletes a rule from its dialog", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(saved().routing.map((r) => r.id)).toEqual(["r1"]);
  });

  it("asks a new rule for no Position or Enabled", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox", { name: "Position" })).toBeNull();
    expect(within(dialog).queryByRole("switch", { name: "Enabled" })).toBeNull();
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
    expect(screen.getByText("No rules")).toBeTruthy();
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

describe("where the rules live", () => {
  it("says the rules are saved on the box, under the first section", () => {
    state.scope = { rules: rules(), overridden: true, home: { name: "box", online: true } };
    render(<OrchestrationPage />);
    const conduct = screen.getByRole("region", { name: "Conduct" });
    expect(within(conduct).getByText("Saved on box")).toBeTruthy();
    expect((within(conduct).getByRole("switch", { name: "File edits" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("names nothing when this host holds the copy", () => {
    render(<OrchestrationPage />);
    expect(screen.queryByText(/Saved on/)).toBeNull();
  });

  it("keeps a workspace's own line and puts the home under it", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    state.scope = { rules: rules(), overridden: false, home: { name: "box", online: true } };
    render(<OrchestrationRulesEditor workspaceId="w1" />);
    const section = screen.getByRole("region", { name: "Orchestration" });
    expect(within(section).getByText("Follows the global rules.")).toBeTruthy();
    expect(within(section).getByText("Saved on box")).toBeTruthy();
  });

  it("turns every control off while the box is offline, and says so", () => {
    state.scope = { rules: rules(), overridden: true, home: { name: "box", online: false } };
    render(<OrchestrationPage />);
    expect(screen.getByText("box is offline")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "File edits" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Delegation" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Who may spawn Opus" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit rule: Bulk work" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a write the box refuses slides the switch back and says why", async () => {
    state.scope = { rules: rules(), overridden: true, home: { name: "box", online: true } };
    state.save.mockImplementation(async () => {
      throw new Error("refused: orchestration rules and thread defaults live on box; it is offline");
    });
    render(<OrchestrationPage />);
    const edits = screen.getByRole("switch", { name: "File edits" });
    await act(async () => {
      fireEvent.click(edits);
    });
    expect(edits.getAttribute("aria-checked")).toBe("false");
    expect(state.toastError).toHaveBeenCalledWith("Couldn't save the rules", {
      description: "Orchestration rules and thread defaults live on box; it is offline",
    });
  });

  it("reads the scope again at mount, so a follow on this host shows", () => {
    render(<OrchestrationPage />);
    expect(state.load).toHaveBeenCalledWith("local", null, true);
  });
});

describe("Meta's rows in the subagent models table", () => {
  const META_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const CLAUDE_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
  const wonder = (reasoning: readonly string[]) =>
    ({ id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: [...reasoning], defaultReasoning: "high", context: 1_048_576, vendor: "meta" }) as RulesCatalog["claude"]["models"][number];

  beforeEach(() => {
    state.catalog = {
      claude: { ...CATALOG.claude, models: [...CATALOG.claude.models, wonder(CLAUDE_LADDER)] },
      codex: { ...CATALOG.codex, models: [...CATALOG.codex.models, wonder(META_LADDER)] },
    };
    state.scope = {
      rules: rules({ models: { "claude:muse-wonder-1.0": { approved: true }, "codex:muse-wonder-1.0": { approved: true } } }),
      overridden: false,
    };
  });

  it("lists Wonder under Claude and Codex, Minimal on the Codex row's ladder alone", async () => {
    render(<OrchestrationPage />);
    const spawn = screen.getAllByRole("combobox", { name: "Who may spawn Muse Wonder 1.0" });
    expect(spawn).toHaveLength(2);
    const [claudeLow, codexLow] = screen.getAllByRole("combobox", { name: "Muse Wonder 1.0 lowest effort" });
    expect(claudeLow.textContent).toContain("Low");
    expect(codexLow.textContent).toContain("Minimal");
    await act(async () => {
      fireEvent.click(codexLow);
    });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
  });
});

describe("every provider of the host's catalog", () => {
  const LIVE: RulesCatalog = {
    claude: CATALOG.claude,
    codex: CATALOG.codex,
    cursor: { id: "cursor", label: "Cursor", defaultModel: "composer", models: [{ id: "composer", label: "Composer", reasoning: [] }] },
    grok: { id: "grok", label: "Grok Build", defaultModel: "", models: [] },
    muse: {
      id: "muse",
      label: "Muse Code",
      defaultModel: "muse-spark-1.3",
      models: [
        { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: ["minimal", "low", "high"] },
        { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", reasoning: ["low", "high"] },
        { id: "muse-spark-1.3", label: "Muse Spark 1.3", reasoning: ["low", "high"] },
        { id: "muse-spark-1.2", label: "Muse Spark 1.2", reasoning: [] },
      ],
    },
  };

  beforeEach(() => {
    state.catalog = LIVE;
    // What rules.get answers once the host has probed: withProbedDefaults
    // gave each Muse row its default.
    const { withProbedDefaults } = shared;
    const { CATALOG: STATIC } = catalogModule;
    const before = STATIC.muse.models;
    STATIC.muse.models = LIVE.muse!.models;
    try {
      state.scope = { rules: withProbedDefaults(rules({ models: { "claude:opus": { approved: true }, "claude:retired": { approved: "orchestrators" } } })), overridden: false };
    } finally {
      STATIC.muse.models = before;
    }
  });

  it("heads every provider in the catalog's order, each with its mark", () => {
    render(<OrchestrationPage />);
    const groups = [...screen.getByRole("table").querySelectorAll("[data-slot=table-group-row]")];
    expect(groups.map((g) => g.textContent)).toEqual(["Claude", "Codex", "Cursor", "Grok Build", "Muse Code"]);
    for (const g of groups) expect(g.querySelector("img, svg")).toBeTruthy();
  });

  it("lists the probed Muse rows, each with a policy control, Wonder Full for orchestrators only", () => {
    render(<OrchestrationPage />);
    for (const label of ["Muse Wonder 1.0", "Muse Wonder Full 1.0", "Muse Spark 1.3", "Muse Spark 1.2"])
      expect(screen.getByRole("combobox", { name: `Who may spawn ${label}` })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Who may spawn Muse Wonder Full 1.0" }).textContent).toContain("Orchestrators only");
    expect(screen.getByRole("combobox", { name: "Who may spawn Muse Wonder 1.0" }).textContent).toContain("Everyone");
    // The ladder is the host's row's, not the renderer's static copy (empty for Muse).
    expect(screen.getByRole("combobox", { name: "Muse Wonder 1.0 lowest effort" }).textContent).toContain("Minimal");
  });

  it("says why a provider with no models has none", () => {
    render(<OrchestrationPage />);
    const line = screen.getByText("No models until Grok Build is installed and signed in");
    expect(line.className).toContain("text-muted-foreground");
    expect(screen.queryByText(/No models until Muse Code/)).toBeNull();
  });

  it("keeps a saved policy for a model this host lacks, muted, and saves a change to it", async () => {
    render(<OrchestrationPage />);
    const row = screen.getByText("not on this host").closest("tr")!;
    expect(row.textContent).toContain("retired");
    expect(row.querySelector("td")!.className).toContain("text-muted-foreground");
    const spawn = within(row).getByRole("combobox", { name: "Who may spawn retired" });
    expect(spawn.textContent).toContain("Orchestrators only");
    await choose(spawn, "Everyone");
    expect(saved().models["claude:retired"]).toEqual({ approved: true });
  });

  it("offers only providers with models in a rule's dialog", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Bulk work");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("combobox", { name: "Provider" }));
    });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Claude", "Codex", "Cursor", "Muse Code"]);
  });
});
