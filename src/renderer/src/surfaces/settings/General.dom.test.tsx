// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linear = vi.hoisted(() => ({
  connected: false,
  save: vi.fn(),
  teams: [] as { id: string; name: string; key: string }[],
}));
const update = vi.hoisted(() => ({ snapshot: { phase: "idle", currentVersion: "1.0.300" } as Record<string, unknown> }));

vi.mock("../../lib/linear", () => ({
  linearConnected: async () => ({ connected: linear.connected }),
  saveLinearToken: (...args: unknown[]) => linear.save(...args),
  disconnectLinear: async () => ({ connected: false }),
  listLinearTeams: async () => linear.teams,
  loadHiddenLinearTeamIds: () => ["t2"],
  saveHiddenLinearTeamIds: vi.fn(),
  notifyLinearChange: vi.fn(),
}));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/githubTasks", () => ({ clearInboxCache: vi.fn() }));
vi.mock("../../lib/updateStore", () => ({
  updateStore: { install: vi.fn(), check: vi.fn() },
  useUpdateSnapshot: () => update.snapshot,
}));
vi.mock("../../lib/sounds", () => ({ loadSoundsEnabled: () => true, saveSoundsEnabled: vi.fn(), playCue: vi.fn() }));
vi.mock("../../chrome/PlanSettingsFields", () => ({ PlanSettingsEditor: () => null }));
vi.mock("../EditorRow", () => ({ EditorRow: () => null }));
vi.mock("../chunks", () => ({ releaseNotesChunk: { intent: {} } }));

const { GeneralPage, updateActionLabel } = await import("./General");
const settings = await import("../../lib/settings");

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

beforeEach(() => {
  mockLocalStorage();
  linear.connected = false;
  linear.teams = [];
  linear.save.mockReset();
  update.snapshot = { phase: "idle", currentVersion: "1.0.300" };
});
afterEach(cleanup);

const page = () => render(<GeneralPage onOpenWhatsNew={() => {}} />);

describe("General", () => {
  it("lays its sections out in order", async () => {
    page();
    await act(async () => {});
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Transcript",
      "Composer",
      "Rail",
      "Linear",
      "Extras",
      "About",
    ]);
  });

  it("saves a switch's setting", async () => {
    page();
    await act(async () => {});
    const notes = screen.getByRole("switch", { name: "Notes" });
    expect(notes.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(notes);
    expect(settings.loadNotesEnabled()).toBe(false);
    expect(notes.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a spinner while Linear connects, and the refusal under the row", async () => {
    let refuse: (error: Error) => void = () => {};
    linear.save.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    page();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Linear API key"), { target: { value: "lin_api_x" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    expect(screen.getByRole("button", { name: /Connect/ }).querySelector("[data-slot=spinner]")).toBeTruthy();
    await act(async () => refuse(new Error("That key was refused.")));
    expect(screen.getByText("That key was refused.").className).toContain("text-destructive");
  });

  it("lists the teams with a box each, hidden ones unchecked", async () => {
    linear.connected = true;
    linear.teams = [
      { id: "t1", name: "Core", key: "COR" },
      { id: "t2", name: "Web", key: "WEB" },
    ];
    page();
    await waitFor(() => screen.getByRole("region", { name: "Teams in the inbox" }));
    expect(screen.getByRole("checkbox", { name: "Core" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Web" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("names the release action for each updater phase", () => {
    const plain = { canApply: true, retry: false };
    expect(updateActionLabel("idle", plain)).toBe("Check for updates");
    expect(updateActionLabel("available", plain)).toBe("Update");
    expect(updateActionLabel("available", { canApply: false, retry: false })).toBe("Check for updates");
    expect(updateActionLabel("ready", plain)).toBe("Restart");
    expect(updateActionLabel("error", { canApply: true, retry: true })).toBe("Retry");
  });

  it("draws the release row with its version and a primary action when there is one", async () => {
    update.snapshot = { phase: "ready", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true };
    page();
    await act(async () => {});
    expect(screen.getByText("1.0.300")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" }).dataset.variant).toBe("default");
    expect(screen.getByRole("button", { name: "What's new" }).dataset.variant).toBe("secondary");
  });

  it("shows the download's progress", async () => {
    update.snapshot = { phase: "downloading", currentVersion: "1.0.300", availableVersion: "1.0.301", percent: 40, canApply: true };
    page();
    await act(async () => {});
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuenow")).toBe("40");
  });
});
