// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";

const state = vi.hoisted(() => ({
  failed: false,
  retry: vi.fn(),
  ladder: ["low", "medium", "high"] as string[],
  overridden: false,
  home: undefined as { name: string; online: boolean } | undefined,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  overriding: new Set<string>(),
  save: vi.fn(async () => {}),
  open: vi.fn(),
  picker: vi.fn(),
  hooks: vi.fn(),
  hosts: 1,
  startOn: undefined as "box" | "mac" | undefined,
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../chrome/PlanSettingsFields", () => ({ PlanSettingsEditor: () => <section aria-label="Plans" /> }));
const link = vi.hoisted(() => ({ environmentId: "local", connected: true, onOpen: () => () => {} }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => link } }));
vi.mock("../../lib/connection/status", () => ({
  useEnvironments: () => Array.from({ length: state.hosts }, (_, i) => ({ id: i ? `env_${i}` : "local", name: i ? "box" : "This Mac" })),
}));
vi.mock("../../lib/settings", () => ({
  openWorkspaceSettings: (id: string) => state.open(id),
  loadClaudeHooks: () => false,
  saveClaudeHooks: (on: boolean) => state.hooks(on),
}));
const probe = vi.hoisted(() => ({
  answer: "installed" as "installed" | "none" | "pending" | "refused",
  reads: 0,
}));
vi.mock("../../lib/harness/availability", () => ({
  readHarnessAvailability: () => {
    probe.reads += 1;
    if (probe.answer === "pending") return new Promise(() => {});
    if (probe.answer === "refused") return Promise.reject(new Error("doctor.get failed: no handler"));
    const on = probe.answer === "installed";
    return Promise.resolve({ claude: on, codex: on, cursor: false, grok: false, opencode: false, pi: false, omp: false, fx: false, muse: false });
  },
}));
vi.mock("../../lib/models", async (original) => ({
  ...(await original<typeof import("../../lib/models")>()),
  isPickerProviderVisible: () => true,
  savePickerProviderVisible: (...args: unknown[]) => state.picker(...args),
}));
vi.mock("../../chrome/HarnessIcon", () => ({ HarnessIcon: () => <svg /> }));
vi.mock("../../lib/tcserver/defaults", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/defaults")>()),
  modelForDefaults: () => ({ id: "m" }),
  effortLadder: () => state.ladder,
  normalizeDefaults: (d: unknown) => d,
  providerOptions: () => [
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
  ],
  modelOptions: () => [{ value: "opus", label: "Opus" }],
  storedModelId: (d: { model: string }) => d.model,
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  scopeKey: (env: string, id: string) => `${env}:${id}`,
  useThreadDefaults: () =>
    state.failed
      ? undefined
      : {
          defaults: { provider: "claude", model: "", reasoning: "medium", permission: "edits", ...(state.startOn ? { startOn: state.startOn } : {}) },
          overridden: state.overridden,
          home: state.home,
        },
  useThreadDefaultsError: () => (state.failed ? { error: "The host did not answer", retry: state.retry } : null),
  useWorkspaceCatalog: () => ({
    workspaces: state.workspaces,
    defaults: new Map([...state.overriding].map((id) => [`local:${id}`, { overridden: true }])),
  }),
  workspaceStore: { saveDefaults: (...args: unknown[]) => state.save(...(args as [])) },
}));

const { ThreadDefaultsPage } = await import("./ThreadDefaults");
const { ThreadDefaultsDialog, ThreadDefaultsEditor } = await import("../../chrome/ThreadDefaultsDialog");

beforeEach(() => {
  probe.answer = "installed";
  probe.reads = 0;
  state.failed = false;
  state.retry.mockClear();
  state.ladder = ["low", "medium", "high"];
  state.overridden = false;
  state.home = undefined;
  state.workspaces = [];
  state.overriding = new Set();
  state.save.mockClear();
  state.open.mockClear();
  state.picker.mockClear();
  state.hooks.mockClear();
  state.hosts = 1;
  state.startOn = undefined;
});
afterEach(cleanup);

describe("Thread defaults kept on the box", () => {
  it("says where the set lives, and turns its pickers off while that host is offline", () => {
    state.home = { name: "box", online: true };
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(screen.getByText("Saved on box")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Provider" }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    state.home = { name: "box", online: false };
    render(<ThreadDefaultsPage />);
    expect(screen.getByText("box is offline")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Provider" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Permission mode" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("New threads start on", () => {
  it("shows on the global set only once a second host is saved, the box by default", () => {
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "New threads start on" })).toBeNull();
    unmount();
    state.hosts = 2;
    render(<ThreadDefaultsPage />);
    const field = screen.getByRole("combobox", { name: "New threads start on" });
    expect(field.textContent).toContain("Box");
    expect(screen.getByText("For projects on more than one host.")).toBeTruthy();
  });

  it("saves the pick with the rest of the global set", async () => {
    state.hosts = 2;
    render(<ThreadDefaultsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "New threads start on" }));
    });
    const option = await screen.findByRole("option", { name: "Mac" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(state.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ provider: "claude", startOn: "mac" }));
  });

  it("reads a saved Mac, and never shows on a workspace's own set", async () => {
    state.hosts = 2;
    state.startOn = "mac";
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(screen.getByRole("combobox", { name: "New threads start on" }).textContent).toContain("Mac");
    unmount();
    render(<ThreadDefaultsDialog workspace={{ id: "w1", name: "Alpha", environmentId: "local" } as never} onClose={() => {}} />);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("combobox", { name: "New threads start on" })).toBeNull();
  });
});

describe("Thread defaults", () => {
  it("has a picker each for provider, model, reasoning and security, under no heading of its own", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("heading", { name: "New threads" })).toBeNull();
    expect(screen.getByRole("region", { name: "Plans" })).toBeTruthy();
    for (const name of ["Provider", "Model", "Reasoning", "Permission mode"]) {
      expect(screen.getByRole("combobox", { name })).toBeTruthy();
    }
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Provider default");
  });

  it("drops Reasoning for a model without a ladder", () => {
    state.ladder = [];
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Reasoning" })).toBeNull();
  });

  it("offers Reset only when the global set differs from the built-in one", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("resets the global set to the built-in one", async () => {
    state.overridden = true;
    render(<ThreadDefaultsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", null, null);
  });

  it("links each workspace that overrides it", () => {
    state.workspaces = [
      { id: "w1", name: "Alpha", environmentId: "local" },
      { id: "w2", name: "Beta", environmentId: "local" },
    ];
    state.overriding = new Set(["w2"]);
    render(<ThreadDefaultsPage />);
    expect(screen.getByTestId("defaults-overrides").textContent).toContain("Overridden in");
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(state.open).toHaveBeenCalledWith("w2");
  });

  it("edits a workspace's set in a dialog: named pickers, Cancel and Save", async () => {
    const onClose = vi.fn();
    render(<ThreadDefaultsDialog workspace={{ id: "w1", name: "Alpha", environmentId: "local" } as never} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("heading", { name: "Thread defaults" })).toBeTruthy();
    expect(dialog.textContent).toContain("Alpha");
    for (const name of ["Provider", "Model", "Permission mode"]) expect(screen.getByRole("combobox", { name })).toBeTruthy();
    expectModalShape(dialog);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", "w1", expect.objectContaining({ provider: "claude" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("puts an overriding workspace's Remove override at the footer's start", async () => {
    state.overridden = true;
    render(<ThreadDefaultsDialog workspace={{ id: "w1", name: "Alpha", environmentId: "local" } as never} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    const start = dialog.querySelector('[data-slot="dialog-footer"] [data-footer-start]');
    expect(start?.textContent).toBe("Remove override");
  });

  it("spins the verb that runs: Remove override, never Save", async () => {
    state.overridden = true;
    let land: () => void = () => {};
    state.save.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    render(<ThreadDefaultsDialog workspace={{ id: "w1", name: "Alpha", environmentId: "local" } as never} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove override" }));
    const busyOf = (name: string) => within(dialog).getByRole("button", { name }).querySelector("[data-slot=busy-label]")?.hasAttribute("data-busy");
    expect(busyOf("Remove override")).toBe(true);
    expect(busyOf("Save")).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.save).toHaveBeenCalledWith("local", "w1", null);
    await act(async () => land());
  });

  it("a workspace's dialog whose host never answers says so in the rows' place, Retry at the footer's start, Save off", async () => {
    state.failed = true;
    render(<ThreadDefaultsDialog workspace={{ id: "w1", name: "Alpha", environmentId: "local" } as never} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe("The host did not answer");
    expect(dialog.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
    const start = dialog.querySelector('[data-slot="dialog-footer"] [data-footer-start]') as HTMLElement;
    const retry = within(start).getByRole("button", { name: "Retry" });
    expect(retry.getAttribute("data-variant")).toBe("ghost");
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(state.retry).toHaveBeenCalledOnce();
    expectModalShape(dialog);
  });

  it("says a workspace follows or overrides the global set only once its host has said", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    state.failed = true;
    const { unmount } = render(<ThreadDefaultsEditor workspaceId="w1" />);
    expect(document.body.textContent).not.toContain("the global defaults");
    unmount();
    state.failed = false;
    render(<ThreadDefaultsEditor workspaceId="w1" />);
    expect(document.body.textContent).toContain("Follows the global defaults.");
  });

  it("lists a picker switch per installed CLI, and saves its visibility", async () => {
    render(<ThreadDefaultsPage />);
    const picker = screen.getByRole("region", { name: "Model picker" });
    const switches = await within(picker).findAllByRole("switch");
    expect(switches).toHaveLength(2);
    fireEvent.click(switches[0]);
    expect(state.picker).toHaveBeenCalledWith("claude", false);
  });

  it("holds the Model picker's rows in their shape until the CLI probe answers", () => {
    probe.answer = "pending";
    render(<ThreadDefaultsPage />);
    const picker = screen.getByRole("region", { name: "Model picker" });
    expect(within(picker).queryAllByRole("switch")).toHaveLength(0);
    const rows = [...picker.querySelectorAll<HTMLElement>("[data-slot=page-row-skeleton]")];
    expect(rows.map((r) => r.dataset.control)).toEqual(["switch", "switch"]);
  });

  it("says a refused probe with Retry instead of hiding the Model picker as if no CLI were installed", async () => {
    probe.answer = "refused";
    render(<ThreadDefaultsPage />);
    const picker = screen.getByRole("region", { name: "Model picker" });
    const alert = await within(picker).findByRole("alert");
    expect(alert.textContent).toBe("doctor.get failed: no handler");
    expect(picker.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
    probe.answer = "installed";
    fireEvent.click(within(picker).getByRole("button", { name: "Retry" }));
    expect(await within(picker).findAllByRole("switch")).toHaveLength(2);
    expect(probe.reads).toBe(2);
  });

  it("leaves the Model picker out only when the host answered with no CLI", async () => {
    probe.answer = "none";
    render(<ThreadDefaultsPage />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Model picker" })).toBeNull();
  });

  it("ends the skeleton when defaults.get does not answer: the error and Retry, no made-up set", () => {
    state.failed = true;
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The host did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("saves the settings.json hooks switch", () => {
    render(<ThreadDefaultsPage />);
    const section = screen.getByRole("region", { name: "Claude Code" });
    fireEvent.click(within(section).getByRole("switch", { name: "settings.json hooks" }));
    expect(state.hooks).toHaveBeenCalledWith(true);
  });
});
