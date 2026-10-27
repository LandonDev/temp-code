// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ladder: ["low", "medium", "high"] as string[],
  overridden: false,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  overriding: new Set<string>(),
  save: vi.fn(async () => {}),
  open: vi.fn(),
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../chrome/PlanSettingsFields", () => ({ PlanSettingsEditor: () => <section aria-label="Plans" /> }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/settings", () => ({ openWorkspaceSettings: (id: string) => state.open(id) }));
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
  useThreadDefaults: () => ({
    defaults: { provider: "claude", model: "", reasoning: "medium", permission: "edits" },
    overridden: state.overridden,
  }),
  useWorkspaceCatalog: () => ({
    workspaces: state.workspaces,
    defaults: new Map([...state.overriding].map((id) => [`local:${id}`, { overridden: true }])),
  }),
  workspaceStore: { saveDefaults: (...args: unknown[]) => state.save(...(args as [])) },
}));

const { ThreadDefaultsPage } = await import("./ThreadDefaults");
const { ThreadDefaultsDialog } = await import("../../chrome/ThreadDefaultsDialog");

beforeEach(() => {
  state.ladder = ["low", "medium", "high"];
  state.overridden = false;
  state.workspaces = [];
  state.overriding = new Set();
  state.save.mockClear();
  state.open.mockClear();
});
afterEach(cleanup);

describe("Thread defaults", () => {
  it("has a picker each for provider, model, reasoning and security, under no heading of its own", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("heading", { name: "New threads" })).toBeNull();
    expect(screen.getByRole("region", { name: "Plans" })).toBeTruthy();
    for (const name of ["Provider", "Model", "Reasoning", "Security"]) {
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
    for (const name of ["Provider", "Model", "Security"]) expect(screen.getByRole("combobox", { name })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", "w1", expect.objectContaining({ provider: "claude" }));
    expect(onClose).toHaveBeenCalled();
  });
});
