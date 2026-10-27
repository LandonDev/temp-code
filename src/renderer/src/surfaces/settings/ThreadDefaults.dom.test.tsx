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

beforeEach(() => {
  state.ladder = ["low", "medium", "high"];
  state.workspaces = [];
  state.overriding = new Set();
  state.save.mockClear();
  state.open.mockClear();
});
afterEach(cleanup);

describe("Thread defaults", () => {
  it("has a picker each for provider, model, reasoning and security", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.getByRole("region", { name: "New threads" })).toBeTruthy();
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

  it("resets the global set to the built-in one", async () => {
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
});
